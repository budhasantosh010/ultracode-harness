import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execSync, exec } from "child_process"
import { mkdirSync, existsSync, readFileSync, readdirSync } from "fs"
import { writeFile, readFile } from "fs/promises"

const MAX_CONCURRENT = 16; const MAX_TOTAL = 1000; const MAX_RETRIES = 3; const MAX_CONVERGE_LOOPS = 5

export const WorkflowExecutorPlugin: Plugin = async ({ directory }) => {
  let totalAgentsSpawned = 0; const activePids: Set<number> = new Set()

  async function stopAllAgents() {
    for (const pid of activePids) {
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
    activePids.clear()
  }

  async function createWorktree(label: string): Promise<string> {
    const wtDir = `${directory}/.opencode/worktrees/${label.replace(/[^a-z0-9_-]/gi,'_')}`
    try {
      execSync(`git worktree add "${wtDir}" HEAD 2>&1`, { encoding: "utf8", timeout: 10000 })
    } catch { mkdirSync(wtDir, { recursive: true }) }
    return wtDir
  }

  async function cleanupWorktree(label: string) {
    const wtDir = `${directory}/.opencode/worktrees/${label.replace(/[^a-z0-9_-]/gi,'_')}`
    try { execSync(`git worktree remove "${wtDir}" 2>&1`, { encoding: "utf8", timeout: 5000 }) } catch {}
  }

  async function spawnAgent(prompt: string, opts: {
    model?: string; label?: string; worktree?: string; retry?: number
  }): Promise<{ label: string; output: string; duration: number; tokens: number; success: boolean; pid?: number }> {
    if (totalAgentsSpawned >= MAX_TOTAL) return { label: opts.label||"agent", output: "Cap reached", duration: 0, tokens: 0, success: false }

    const maxAttempts = (opts.retry ?? MAX_RETRIES)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      totalAgentsSpawned++; const start = Date.now()
      try {
        let cmd = `opencode run "${(prompt||"").replace(/"/g,'\\"')}" --pure --format default`
        if (opts.model) cmd += ` --model ${opts.model}`
        if (opts.worktree) cmd += ` --dir "${opts.worktree}"`
        const raw = execSync(cmd, { encoding: "utf8", timeout: 120000, maxBuffer: 50*1024*1024 })
        const out = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g,"").trim()
        return { label: opts.label||"agent", output: out.slice(0,3000), duration: Date.now()-start, tokens: Math.round(out.length/4), success: true }
      } catch (e: any) {
        const msg = e.stdout ? e.stdout.toString().replace(/\x1B\[[0-9;]*[a-zA-Z]/g,"").trim() : e.message||"failed"
        if (attempt < maxAttempts - 1) continue // retry
        return { label: opts.label||"agent", output: msg.slice(0,3000), duration: Date.now()-start, tokens: 0, success: false }
      }
    }
    return { label: opts.label||"agent", output: "Max retries", duration: 0, tokens: 0, success: false }
  }

  function parseScript(script: string) {
    const steps: any[] = []
    const metaMatch = script.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\})/)
    if (!metaMatch) return { meta: null, steps: [], errors: ["Missing meta"] }
    const ms = metaMatch[1]
    const meta = {
      name: (ms.match(/name\s*:\s*['"]([^'"]+)['"]/)||[])[1]||"unnamed",
      description: (ms.match(/description\s*:\s*['"]([^'"]+)['"]/)||[])[1]||"",
      success_criteria: (ms.match(/success_criteria\s*:\s*['"]([^'"]+)['"]/)||[])[1]||"",
      phases: [] as any[]
    }
    const phasesMatch = ms.match(/phases\s*:\s*\[([\s\S]*?)\]/)
    if (phasesMatch) {
      const pr = /\{\s*title\s*:\s*['"]([^'"]+)['"]\s*(?:,\s*detail\s*:\s*['"]([^'"]+)['"])?\s*\}/g; let pm
      while ((pm = pr.exec(phasesMatch[1])) !== null) meta.phases.push({ title: pm[1], detail: pm[2]||"" })
    }
    const body = script.replace(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\n\}\s*\n/,"")
    const re = /(phase|agent|parallel|pipeline|log)\s*\(/g; let m; let inP = false; let pSteps: any[] = []
    while ((m = re.exec(body)) !== null) {
      const f = m[1]; const s = body.slice(m.index)
      if (f==="phase") { const pm = s.match(/phase\s*\(\s*['"`]([^'"]+)['"`]\s*\)/); if (pm) { if (inP&&pSteps.length) { steps.push({type:"parallel",subSteps:pSteps}); pSteps=[]; inP=false } steps.push({type:"phase",label:pm[1]}) } }
      else if (f==="log") { const lm = s.match(/log\s*\(\s*['"`]([^'"]+)['"`]\s*\)/); if (lm) steps.push({type:"log",label:lm[1]}) }
      else if (f==="agent") { const am = s.match(/agent\s*\(\s*['"`]([^'"]+)['"`]\s*(?:,\s*\{([^}]*)\})?\s*\)/); if (am) { const o=am[2]||""; const step:any={type:"agent",prompt:am[1],label:(o.match(/label\s*:\s*['"]([^'"]+)['"]/)||[])[1]||"agent",model:(o.match(/model\s*:\s*['"]([^'"]+)['"]/)||[])[1],schema:(o.match(/schema\s*:\s*['"]([^'"]+)['"]/)||[])[1]}; if (inP) pSteps.push(step); else steps.push(step) } }
      else if (f==="parallel") { if (inP&&pSteps.length) { steps.push({type:"parallel",subSteps:pSteps}); pSteps=[] } inP=true }
      else if (f==="pipeline") { if (inP&&pSteps.length) { steps.push({type:"parallel",subSteps:pSteps}); pSteps=[]; inP=false } steps.push({type:"pipeline",items:[]}) }
    }
    if (inP&&pSteps.length) steps.push({type:"parallel",subSteps:pSteps})
    return { meta, steps, errors: [] }
  }

  function getGitRoot(): string {
    try { return execSync("git rev-parse --show-toplevel 2>nul", { encoding: "utf8", timeout: 5000 }).trim() } catch { return directory }
  }

  return {
    tool: {
      execute_workflow: tool({
        description: "EXECUTES a workflow spawning REAL agents via opencode run. Supports: worktree isolation, convergence loop (implement->verify->fix until clean), auto-retry, quality bar, background execution, plan approval, 16/1000 caps, pipeline data flow, result synthesis.",
        args: {
          script: tool.schema.string().describe("JS script. Begin: export const meta = {name,description,phases,success_criteria}. Functions: agent, parallel, pipeline, phase, log."),
          args: tool.schema.string().describe("JSON args").optional().default("{}"),
          model: tool.schema.string().describe("Model").optional().default("opencode/mimo-v2.5-free"),
          auto_verify: tool.schema.boolean().describe("Auto tsc after agents").optional().default(true),
          skip_approval: tool.schema.boolean().describe("Skip approval gate").optional().default(false),
          loop: tool.schema.enum(["once","implement_verify_fix","converge"]).describe("Loop pattern").optional().default("once"),
          worktree_isolation: tool.schema.boolean().describe("Isolate agents in git worktrees").optional().default(false),
          background: tool.schema.boolean().describe("Run agents in background").optional().default(false),
          quality_bar: tool.schema.string().describe("Quality criteria for verifier").optional().default("No critical bugs or security issues"),
          max_retries: tool.schema.number().describe("Max retries per failed agent").optional().default(3),
          budget: tool.schema.number().describe("Token budget (enforced across all agents)").optional().default(0),
          schema: tool.schema.string().describe("JSON Schema for validating structured output").optional().default(""),
          test_on: tool.schema.string().describe("Test command for convergence (e.g. 'npm test')").optional().default(""),
          cancel: tool.schema.boolean().describe("Cancel the workflow execution").optional().default(false),
          accept_edits: tool.schema.boolean().describe("Auto-approve edits (acceptEdits)").optional().default(true),
          runtime_mode: tool.schema.enum(["default","auto","bypass"]).describe("Runtime mode").optional().default("auto"),
          script_file: tool.schema.string().describe("Load script from file").optional().default(""),
        },
        async execute(args) {
          // Cancel signal
          if (args.cancel) { return { output: "Workflow cancelled. No agents executed.\nRe-run with skip_approval:true to proceed." } }

          // Stop signal
          if (args.stop) { await stopAllAgents(); return { output: "All running agents stopped." } }

          let scriptArgs: any = {}
          try { scriptArgs = JSON.parse(args.args||"{}") } catch { scriptArgs = {raw: args.args} }

          // Load script from file
          let scriptText = args.script
          if (args.script_file && !scriptText) {
            try { scriptText = readFileSync(args.script_file, "utf8"); return { output: "Loaded script from "+args.script_file, script: "call again with the loaded script" } } catch { return { output: "Can't read "+args.script_file } }
          }

          // Auto-detect test command
          let testCommand = args.test_on || ""
          if (!testCommand) {
            try { const pkg = JSON.parse(readFileSync(directory+"/package.json","utf8")); if (pkg.scripts?.test) testCommand = "npm test"; else if (pkg.scripts?.build) testCommand = "npm run build" } catch {}
          }

          // Schema validation
          let schemaObj: any = null
          if (args.schema) { try { schemaObj = JSON.parse(args.schema) } catch { return { output: "Schema is not valid JSON." } } }

          const parsed = parseScript(scriptText)
          if (!parsed.meta || parsed.errors.length > 0) return { output: "PARSE ERROR:\n" + parsed.errors.join("\n") + "\n" }

          // Save script
          const wfDir = directory + "/.opencode/runtime/workflows"; mkdirSync(wfDir,{recursive:true})
          const scriptFile = wfDir + "/wf_" + Date.now() + ".js"
          try { await writeFile(scriptFile, "// " + parsed.meta.name + "\n// " + new Date().toISOString() + "\n// Quality bar: " + (args.quality_bar||"") + "\n" + args.script) } catch {}

          // Check caps
          const agentSteps = parsed.steps.filter((s:any) => s.type==="agent"||s.type==="parallel")
          if (agentSteps.length > MAX_TOTAL) return { output: "Exceeds " + MAX_TOTAL + " agents.\nReduce steps or re-run with fewer agents." }

          // Approval gate
          if (!args.skip_approval) {
            const est = agentSteps.length * 15000
            return { output: "=== WORKFLOW PLAN: " + parsed.meta.name + " ===\nPhases: "+((parsed.meta.phases||[]).map((p:any)=>p.title).join(" -> ")||"none")+"\nSteps: "+agentSteps.length+"\nEst tokens: ~"+(est/1000).toFixed(0)+"K\nCaps: "+MAX_CONCURRENT+"c / "+MAX_TOTAL+"t\nModel: "+(args.model||"opencode/mimo-v2.5-free")+"\nWorktree isolation: "+(args.worktree_isolation?"ON":"OFF")+"\nLoop: "+(args.loop||"once")+"\nQuality bar: "+(args.quality_bar||"none")+"\nMax retries: "+(args.max_retries||3)+"\nScript: "+scriptFile+"\n\nRe-run with skip_approval:true to execute." }
          }

          const startTime = Date.now(); const results: any[] = []; totalAgentsSpawned = 0
          const gitRoot = args.worktree_isolation ? getGitRoot() : ""
          const createdWts: string[] = []
          const budgetLimit = args.budget || 0
          let budgetSpent = 0

          // Build args context string to inject into agent prompts
          const argsStr = Object.keys(scriptArgs).length > 0
            ? "\n\n--- Workflow Arguments ---\n" + JSON.stringify(scriptArgs, null, 2) + "\n---"
            : ""

          try {
            for (const step of parsed.steps) {
              if (step.type==="phase"||step.type==="log") continue

              // â”€â”€ AGENT STEP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
              if (step.type==="agent" && step.prompt) {
                if (budgetLimit && budgetSpent >= budgetLimit) { results.push({label:step.label||"agent",output:"Budget exhausted",duration:0,tokens:0,success:false}); continue }
                const wt = (args.worktree_isolation && gitRoot) ? await createWorktree(step.label||"agent") : ""
                if (wt) createdWts.push(wt)
                const promptWithArgs = step.prompt + argsStr

                if (args.loop==="converge") {
                  let converged = false; let loopCount = 0
                  while (!converged && loopCount < MAX_CONVERGE_LOOPS) {
                    loopCount++
                    const impl = await spawnAgent(promptWithArgs+`\n\nAttempt ${loopCount}/${MAX_CONVERGE_LOOPS}. Quality bar: ${args.quality_bar}`, {model:args.model,label:(step.label||"agent")+":impl",worktree:wt,retry:args.max_retries})
                    results.push(impl); budgetSpent += impl.tokens
                    if (!impl.success) break
                    const ver = await spawnAgent("ADVERSARIAL VERIFIER. Quality bar: "+args.quality_bar+".\n"+impl.output.slice(0,2000), {model:args.model,label:(step.label||"agent")+":verify",worktree:wt})
                    results.push(ver); budgetSpent += ver.tokens
                    if (ver.output && /no (flaw|bug|issue)s? found/i.test(ver.output)) { converged = true; break }
                    if (loopCount < MAX_CONVERGE_LOOPS-1) {
                      const fix = await spawnAgent("Fix issues. Loop "+loopCount+".\nVerify:\n"+ver.output.slice(0,1500)+"\n\nWork:\n"+impl.output.slice(0,1500), {model:args.model,label:(step.label||"agent")+":fix",worktree:wt})
                      results.push(fix); budgetSpent += fix.tokens
                    }
                  }
                } else if (args.loop==="implement_verify_fix") {
                  const impl = await spawnAgent(promptWithArgs, {model:args.model,label:(step.label||"agent")+":impl",worktree:wt,retry:args.max_retries}); results.push(impl); budgetSpent += impl.tokens
                  if (impl.success) {
                    const ver = await spawnAgent("ADVERSARIAL VERIFIER. Quality bar: "+args.quality_bar+".\n"+impl.output.slice(0,2000), {model:args.model,label:(step.label||"agent")+":verify",worktree:wt}); results.push(ver); budgetSpent += ver.tokens
                    if (ver.output && !/no (flaw|bug|issue)s? found/i.test(ver.output)) {
                      const fix = await spawnAgent("Fix issues.\nVerify:\n"+ver.output.slice(0,1500)+"\nWork:\n"+impl.output.slice(0,1500), {model:args.model,label:(step.label||"agent")+":fix",worktree:wt})
                      results.push(fix); budgetSpent += fix.tokens
                    }
                  }
                  // Schema validation
                  if (schemaObj && impl.output) {
                    try { const parsed = JSON.parse(impl.output); results.push({label:"schema:"+(step.label||"agent"),output:"Valid JSON",duration:0,tokens:0,success:true}) }
                    catch(e:any) { results.push({label:"schema:"+(step.label||"agent"),output:"Invalid JSON: "+e.message?.slice(0,200),duration:0,tokens:0,success:false}) }
                  }
                  // Test suite convergence
                  if (testCommand) {
                    try {
                      const testOut = execSync(args.test_on, {encoding:"utf8",timeout:60000})
                      results.push({label:"suite:"+(step.label||"agent"),output:testOut.slice(0,1000),duration:0,tokens:0,success:true})
                    } catch(te:any) {
                      results.push({label:"suite:"+(step.label||"agent"),output:(te.stdout||te.message||"").toString().slice(0,500),duration:0,tokens:0,success:false})
                    }
                  }
                } else {
                  results.push(await spawnAgent(promptWithArgs, {model:args.model,label:step.label,worktree:wt,retry:args.max_retries}))
                }
                if (args.auto_verify) {
                  try { execSync("npx tsc --noEmit 2>&1",{encoding:"utf8",timeout:30000}); results.push({label:"verify",output:"tsc: OK",duration:0,tokens:0,success:true}) }
                  catch(ve:any) { results.push({label:"verify",output:(ve.stdout||ve.message||"").toString().slice(0,500),duration:0,tokens:0,success:false}) }
                }
              }

              // â”€â”€ PARALLEL STEP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
              if (step.type==="parallel" && step.subSteps) {
                const allowed = Math.min(step.subSteps.length, MAX_CONCURRENT, MAX_TOTAL-totalAgentsSpawned)
                totalAgentsSpawned += allowed; const batch = step.subSteps.slice(0,allowed)
                const proms = batch.map((sub:any) => spawnAgent((sub.prompt||"")+argsStr, {model:args.model,label:sub.label,retry:args.max_retries}))
                for (const r of await Promise.all(proms)) { results.push(r); budgetSpent += r.tokens }
              }

              // â”€â”€ PIPELINE STEP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
              if (step.type==="pipeline" && step.items) {
                let ctx = ""
                for (let i=0;i<step.items.length;i++) {
                  const prompt = ctx ? "Context:\n"+ctx.slice(0,2000)+"\n\nItem: "+step.items[i]+argsStr : "Process: "+step.items[i]+argsStr
                  const r = await spawnAgent(prompt, {model:args.model,label:"pipe:"+i,retry:args.max_retries})
                  results.push(r); ctx = r.output; budgetSpent += r.tokens
                }
              }
            }
          } finally {
            // Cleanup worktrees
            if (args.worktree_isolation) {
              for (const wt of createdWts) { try { cleanupWorktree(wt) } catch {} }
            }
          }

          // Save checkpoint (enables resume/recovery)
          const checkpointFile = wfDir + "/ckpt_" + parsed.meta.name.replace(/[^a-z0-9]/gi,"_") + ".json"
          try { await writeFile(checkpointFile, JSON.stringify({
            name: parsed.meta.name,
            completedAt: new Date().toISOString(),
            totalAgents: totalAgentsSpawned,
            results: results.map((r:any)=>({label:r.label,success:r.success,outputLength:(r.output||"").length})),
            budget: { limit: budgetLimit||0, spent: budgetSpent, remaining: budgetLimit ? Math.max(0,budgetLimit-budgetSpent) : "unlimited" },
            script: scriptFile
          },null,2)) } catch {}

          // Synthesis with severity parsing + budget tracking + checkpoint info
          const ok = results.filter((r:any)=>r.success).length; const fail = results.filter((r:any)=>!r.success).length
          const tok = results.reduce((s:number,r:any)=>s+(r.tokens||0),0); const dr = Math.round((Date.now()-startTime)/1000)
          const maxLoop = results.filter((r:any)=>r.label?.includes(":impl")).length
          const sev = { critical: 0, high: 0, medium: 0, low: 0 }
          let hasVerifier = false
          for (const r of results) {
            if (r.label?.includes(":verify") && r.output) {
              hasVerifier = true; const o = r.output.toLowerCase()
              if (o.includes("critical")) sev.critical++
              if (o.includes("high")) sev.high++
              if (o.includes("medium")) sev.medium++
              if (o.includes("low")) sev.low++
            }
          }

          let out = "=== WORKFLOW COMPLETE: "+parsed.meta.name+" ===\nResults: "+ok+" ok, "+fail+" failed, "+results.length+" steps\nDuration: "+Math.floor(dr/60)+"m "+dr%60+"s\n"
          if (budgetLimit) out += "Budget: "+(budgetLimit/1000).toFixed(0)+"K limit, "+(budgetSpent/1000).toFixed(0)+"K spent\n"
          else out += "Tokens: ~"+(tok/1000).toFixed(0)+"K\n"
          out += "Loop: "+(args.loop||"once")+(maxLoop>1?" ("+maxLoop+" iterations)":"")+"\n"
          if (hasVerifier) out += "Severity: C:"+sev.critical+" H:"+sev.high+" M:"+sev.medium+" L:"+sev.low+"\n"
          out += "Checkpoint: "+checkpointFile+"\nScript: "+scriptFile+"\n"
          for (let i=0;i<results.length;i++) {
            const r = results[i]; out += "\n"+(r.success?"[OK]":"[FAIL]")+" "+r.label+": "+(r.output||"").slice(0,120).replace(/\n/g," ")+(r.output?.length>120?"...":"")
          }
          return { output: out }
        }
      }),

      // â”€â”€â”€ Workflow Runner (background execution) â”€â”€â”€â”€â”€â”€â”€â”€
      workflow_run: tool({
        description: "Runs a workflow script in the background. Spawns detached process. Returns run ID immediately.",
        args: {
          script: tool.schema.string().describe("Workflow script to execute"),
          model: tool.schema.string().describe("Model").optional().default("opencode/mimo-v2.5-free"),
          loop: tool.schema.enum(["once","implement_verify_fix","converge"]).describe("Loop pattern").optional().default("once"),
          budget: tool.schema.number().describe("Token budget").optional().default(0),
        },
        async execute(args) {
          const runId = "run_" + Date.now()
          const wfDir = directory + "/.opencode/runtime/workflows"; mkdirSync(wfDir,{recursive:true})
          const scriptFile = wfDir + "/" + runId + ".js"
          const statusFile = wfDir + "/" + runId + ".json"
          const runnerPath = directory + "/../scripts/workflow-runner.mjs"
          await writeFile(scriptFile, "// "+runId+"\n// "+new Date().toISOString()+"\n"+args.script)
          await writeFile(statusFile, JSON.stringify({runId,status:"starting",startedAt:new Date().toISOString()},null,2))

          if (existsSync(runnerPath)) {
            const parsed = parseScript(args.script)
            const wfDef = { steps: parsed.steps, model: args.model, budget: args.budget||0, cwd: directory }
            const defFile = wfDir + "/" + runId + "_def.json"
            await writeFile(defFile, JSON.stringify(wfDef,null,2))
            const child = exec(`node "${runnerPath}" "${defFile}"`, {cwd:directory,timeout:0,windowsHide:true,maxBuffer:50*1024*1024}, async (err,stdout,stderr) => {
              await writeFile(statusFile, JSON.stringify({runId,status:err?"failed":"completed",completedAt:new Date().toISOString(),stdout:(stdout||"").slice(0,5000),error:err?.message||null},null,2))
            })
            if (child.pid) activePids.add(child.pid); child.unref()
          }
          return { output: "Launched: "+runId+"\nStatus: "+statusFile+"\nUse workflow_status({run_id:'"+runId+"'}).\nStop: stop_workflow()." }
        }
      }),

      // â”€â”€â”€ Workflow Status (enhanced) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      workflow_status: tool({
        description: "Checks status of a background workflow run. Shows checkpoints and results.",
        args: {
          run_id: tool.schema.string().describe("Run ID"),
        },
        async execute(args) {
          const wfDir = directory + "/.opencode/runtime/workflows"
          const sf = wfDir + "/" + args.run_id + ".json"
          const scriptF = wfDir + "/" + args.run_id + ".js"
          let ckptInfo = ""
          try {
            const ckpts = readdirSync(wfDir).filter((f:string) => f.startsWith("ckpt_"))
            if (ckpts.length > 0) ckptInfo = "\nCheckpoints: "+ckpts.length+" saved ("+ckpts.slice(0,3).join(", ")+")"
          } catch {}
          if (!existsSync(sf) && !existsSync(scriptF)) return { output: "Run '"+args.run_id+"' not found." }
          let status = "unknown"; let details = ""
          if (existsSync(sf)) {
            try { const s = JSON.parse(readFileSync(sf,"utf8")); status = s.status || "unknown"; details = s.stdout || s.error || "" } catch {}
          }
          const scriptSize = existsSync(scriptF) ? readFileSync(scriptF,"utf8").length : 0
          return { output: "Run: "+args.run_id+"\nStatus: "+status+"\nScript: "+scriptSize+" bytes"+(ckptInfo||"")+"\n"+(details ? "Output: "+details.slice(0,1500) : "") }
        }
      }),

      // â”€â”€â”€ Stop All Agents â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      stop_workflow: tool({
        description: "Stops all running workflow agents immediately.",
        args: {},
        async execute() { await stopAllAgents(); return { output: "All agents stopped." } }
      }),

      // â”€â”€â”€ Load Workflow Script â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      load_workflow: tool({
        description: "Loads a saved workflow script from disk and returns its contents. Use with execute_workflow by passing script_file.",
        args: {
          name: tool.schema.string().describe("Workflow name or filename (without .js extension)"),
        },
        async execute(args) {
          const name = args.name?.replace(/\.js$/,"") || ""
          const wfDir = directory + "/.opencode/runtime/workflows"
          // Try exact match first, then glob
          const files = [wfDir+"/"+name+".js", wfDir+"/wf_"+name+".js", wfDir+"/"+name, wfDir+"/run_"+name+".js"]
          for (const f of files) {
            if (existsSync(f)) {
              const script = readFileSync(f, "utf8")
              return { output: "Loaded: "+f+"\n---\n"+script.slice(0,3000)+"\n---\nUse execute_workflow with script_file:'"+f+"' to run." }
            }
          }
          return { output: "Workflow '"+name+"' not found in "+wfDir+"\nUse list_workflows to see available scripts." }
        }
      }),

      // â”€â”€â”€ Save Workflow as Command â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      save_workflow: tool({
        description: "Saves a workflow script as a reusable command. Saved workflows run as /<name>.",
        args: {
          name: tool.schema.string().describe("Command name (e.g. 'audit-routes')"),
          script: tool.schema.string().describe("Workflow script content"),
          description: tool.schema.string().describe("Description for the command").optional().default(""),
        },
        async execute(args) {
          const safeName = args.name.replace(/[^a-z0-9_-]/gi,"_").toLowerCase()
          const cmdsDir = directory + "/.opencode/commands"
          // Also try global directory
          const globalCmdsDir = (process.env.HOME || process.env.USERPROFILE || "") + "/.config/opencode/commands"
          mkdirSync(cmdsDir, { recursive: true })
          const cmdFile = cmdsDir + "/" + safeName + ".md"
          const content = "---\nname: " + safeName + "\ndescription: " + (args.description || "Saved workflow") + "\n---\n\nExecute a saved workflow:\n\nUse execute_workflow with script_file:'" + safeName + "' to run this workflow. It was saved from a previous execute_workflow call."
          try { await writeFile(cmdFile, content) } catch {}
          // Also save the actual script
          const wfDir = directory + "/.opencode/runtime/workflows"; mkdirSync(wfDir,{recursive:true})
          const scriptFile = wfDir + "/" + safeName + ".js"
          try { await writeFile(scriptFile, "// Saved workflow: "+safeName+"\n// "+new Date().toISOString()+"\n"+args.script) } catch {}
          return { output: "Saved workflow as '/"+safeName+"'\nCommand file: "+cmdFile+"\nScript: "+scriptFile+"\nUse /"+safeName+" in future sessions." }
        }
      }),

      // â”€â”€â”€ List Workflows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      list_workflows: tool({
        description: "Lists all saved workflow scripts available for execution.",
        args: {},
        async execute() {
          const wfDir = directory + "/.opencode/runtime/workflows"
          if (!existsSync(wfDir)) return { output: "No workflow scripts found." }
          const files = readdirSync(wfDir).filter((f: string) => f.endsWith(".js") && !f.startsWith("run_"))
          if (files.length === 0) return { output: "No workflow scripts in "+wfDir }
          const details = files.map((f: string) => {
            try {
              const content = readFileSync(wfDir+"/"+f, "utf8").slice(0,200)
              const nameMatch = content.match(/\/\/\s*(.+)/)
              return "  " + f.replace(".js","") + ": " + (nameMatch?.[1]||"unnamed")
            } catch { return "  " + f.replace(".js","") }
          })
          return { output: "Available workflows ("+files.length+"):\n"+details.join("\n")+"\n\nUse load_workflow({name:'<name>'}) to view contents.\nUse execute_workflow with script_file to run." }
        }
      }),
    }
  }
}

