// ═══════════════════════════════════════════════════════════════
// ULTRACODE WORKFLOW RUNNER — Real agent execution engine
// Called by the execute_workflow_script plugin tool.
// Spawns REAL agents via `opencode run` CLI.
// ═══════════════════════════════════════════════════════════════
// Usage: node workflow-runner.mjs <workflow.json> [options]
//   workflow.json: { steps: [...], budget: {...}, cache: {...} }
//   Outputs JSON to stdout: { results: [...], budget: {...} }

import { execSync, exec } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);
const RUN_TIMEOUT = 120000; // 2 min per agent
const TOKEN_RATIO = 4; // ~4 chars per token

// ─── Helpers ─────────────────────────────────────────────────

function log(msg) {
  // stderr so it doesn't pollute JSON output
  process.stderr.write(`[workflow-runner] ${msg}\n`);
}

function estimateTokens(text) {
  return Math.round((text?.length || 0) / TOKEN_RATIO);
}

function escapeShellArg(arg) {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

// ─── Agent Execution ─────────────────────────────────────────

function runAgent(prompt, options = {}) {
  const {
    agent = '',
    model = '',
    schema = null,
    cwd = process.cwd(),
  } = options;

  // Build the opencode run command
  let cmd = `opencode run ${escapeShellArg(prompt)} --pure --format default`;
  if (agent) cmd += ` --agent ${agent}`;
  if (model) cmd += ` --model ${model}`;

  log(`Spawning agent${agent ? ` (${agent})` : ''}${model ? ` on ${model}` : ''}`);

  const startTime = Date.now();

  try {
    const result = execSync(cmd, {
      encoding: 'utf8',
      timeout: RUN_TIMEOUT,
      cwd: cwd,
      maxBuffer: 50 * 1024 * 1024, // 50MB
      windowsHide: true,
    });

    // Clean up the result — remove ANSI codes and trim
    const clean = result
      .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') // ANSI escape codes
      .replace(/\r\n/g, '\n')
      .trim();

    const duration = Date.now() - startTime;
    log(`Agent completed in ${(duration / 1000).toFixed(1)}s (${estimateTokens(clean)} estimated tokens)`);

    // If schema validation is requested
    if (schema) {
      // Try to parse the output as JSON matching the schema
      // Extract JSON from the output if wrapped in code fences
      const jsonMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : clean;
      try {
        const parsed = JSON.parse(jsonStr);
        return {
          output: clean,
          parsedJSON: parsed,
          valid: true,
          duration,
          tokens: estimateTokens(clean),
        };
      } catch {
        // Output isn't valid JSON — return as text but flag it
        return {
          output: clean,
          parsedJSON: null,
          valid: false,
          duration,
          tokens: estimateTokens(clean),
        };
      }
    }

    return {
      output: clean,
      parsedJSON: null,
      valid: true,
      duration,
      tokens: estimateTokens(clean),
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    log(`Agent FAILED after ${(duration / 1000).toFixed(1)}s: ${err.message.slice(0, 200)}`);

    // Try to get partial output even on failure
    const partialOutput = err.stdout?.toString?.()?.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')?.trim() || '';
    const stderr = err.stderr?.toString?.()?.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')?.trim() || '';

    return {
      output: partialOutput,
      error: err.message,
      stderr,
      valid: false,
      duration,
      tokens: estimateTokens(partialOutput || err.message),
      failed: true,
    };
  }
}

// ─── Agent Caps (matching Claude Code June 2026) ────────────
const MAX_CONCURRENT = 16;
const MAX_TOTAL = 1000;
const MAX_SCRIPT_ITEMS = 4096;
let totalAgentsSpawned = 0;

function checkAgentCaps(requestedCount) {
  if (totalAgentsSpawned >= MAX_TOTAL) {
    throw new Error(`Agent cap reached: ${MAX_TOTAL} total agents per workflow (Claude Code limit). Remaining agents will be skipped.`);
  }
  const remaining = MAX_TOTAL - totalAgentsSpawned;
  const allowed = Math.min(requestedCount, remaining, MAX_CONCURRENT);
  if (allowed < requestedCount) {
    log(`Capping ${requestedCount} agents to ${allowed} (cap: ${MAX_CONCURRENT} concurrent, ${MAX_TOTAL} total, ${remaining} remaining)`);
  }
  return allowed;
}

// ─── Parallel Agent Execution ────────────────────────────────

async function runParallel(agents, options = {}) {
  // Apply agent caps
  const allowedCount = checkAgentCaps(agents.length);
  const cappedAgents = agents.slice(0, allowedCount);
  totalAgentsSpawned += cappedAgents.length;
  log(`Running ${cappedAgents.length} agents IN PARALLEL (${totalAgentsSpawned}/${MAX_TOTAL} total spawned)`);

  const startTime = Date.now();
  const results = new Array(cappedAgents.length).fill(null);
  const errors = new Array(cappedAgents.length).fill(null);

  // Build all agent calls
  const promises = cappedAgents.map((agentConfig, i) => {
    return new Promise((resolve) => {
      try {
        // For true parallel execution, we use exec (async)
        // But execSync is simpler for individual calls within Promise.all
        // Node's child_process.exec is async so it doesn't block
        const cmd = `opencode run ${escapeShellArg(agentConfig.prompt)} --pure --format default`
          + (agentConfig.agent ? ` --agent ${agentConfig.agent}` : '')
          + (agentConfig.model ? ` --model ${agentConfig.model}` : '');

        exec(cmd, {
          encoding: 'utf8',
          timeout: RUN_TIMEOUT,
          cwd: options.cwd || process.cwd(),
          maxBuffer: 50 * 1024 * 1024,
          windowsHide: true,
        }, (error, stdout, stderr) => {
          if (error) {
            errors[i] = error.message;
            results[i] = stdout?.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')?.trim() || '';
          } else {
            results[i] = stdout?.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')?.trim() || '';
          }
          resolve();
        });
      } catch (err) {
        errors[i] = err.message;
        resolve();
      }
    });
  });

  await Promise.all(promises);
  const duration = Date.now() - startTime;

  log(`Parallel completed: ${results.filter(r => r).length}/${agents.length} succeeded in ${(duration / 1000).toFixed(1)}s`);

  return agents.map((a, i) => ({
    label: a.label || `agent-${i}`,
    output: results[i],
    error: errors[i],
    failed: !!errors[i],
    duration: duration,
    tokens: estimateTokens(results[i] || errors[i] || ''),
  }));
}

// ─── Main Execution ──────────────────────────────────────────

async function main() {
  const workflowPath = process.argv[2];
  if (!workflowPath) {
    process.stderr.write('Usage: node workflow-runner.mjs <workflow.json>\n');
    process.exit(1);
  }

  const workflow = readJSON(workflowPath);
  if (!workflow) {
    process.stderr.write(`Cannot read workflow file: ${workflowPath}\n`);
    process.exit(1);
  }

  const cwd = workflow.cwd || process.cwd();
  const budget = { total: workflow.budget?.total || null, spent: 0, startedAt: new Date().toISOString() };
  const results = [];
  let failedSteps = 0;

  log(`Starting workflow: "${workflow.name || 'unnamed'}" with ${workflow.steps?.length || 0} steps`);
  if (budget.total) log(`Budget: ${budget.total.toLocaleString()} tokens`);

  for (let stepIdx = 0; stepIdx < (workflow.steps || []).length; stepIdx++) {
    const step = workflow.steps[stepIdx];

    // Check budget
    if (budget.total && budget.spent >= budget.total) {
      log(`Budget exhausted at step ${stepIdx}. Stopping.`);
      results.push({
        step: stepIdx,
        type: 'budget_exhausted',
        label: step.label || `step-${stepIdx}`,
        output: null,
        skipped: true,
        reason: `Budget exhausted (${budget.spent}/${budget.total} tokens)`,
      });
      break;
    }

    // Phase and log markers are informational only
    if (step.type === 'phase' || step.type === 'log') {
      log(`[${step.type}] ${step.label}`);
      results.push({
        step: stepIdx,
        type: step.type,
        label: step.label,
        output: step.type === 'log' ? step.label : null,
        duration: 0,
        tokens: 0,
      });
      continue;
    }

    // Agent step
    if (step.type === 'agent') {
      // Cache check: if we have a cache and this step's prompt matches a cache key
      if (workflow.cache) {
        const cacheKey = step.label || step.prompt?.slice(0, 100);
        if (workflow.cache[cacheKey]) {
          log(`CACHE HIT for "${cacheKey}" — skipping`);
          results.push({
            step: stepIdx,
            type: 'agent',
            label: step.label,
            output: workflow.cache[cacheKey].output,
            cached: true,
            duration: 0,
            tokens: 0,
          });
          continue;
        }
      }

      const result = runAgent(step.prompt, {
        agent: step.agent,
        model: step.model,
        schema: step.schema,
        cwd,
      });

      budget.spent += result.tokens || 0;

      if (result.failed) failedSteps++;

      results.push({
        step: stepIdx,
        type: 'agent',
        label: step.label,
        prompt: step.prompt?.slice(0, 100),
        output: result.output,
        parsedJSON: result.parsedJSON,
        valid: result.valid,
        failed: result.failed || false,
        error: result.error || null,
        cached: false,
        duration: result.duration || 0,
        tokens: result.tokens || 0,
      });

      log(`Step ${stepIdx + 1}/${workflow.steps.length} done: "${step.label}" (${result.tokens || 0} tokens)`);
    }

    // Parallel step
    if (step.type === 'parallel' && step.subSteps && step.subSteps.length > 0) {
      const parallelResults = await runParallel(step.subSteps, { cwd });

      for (const pr of parallelResults) {
        budget.spent += pr.tokens || 0;
        if (pr.failed) failedSteps++;
      }

      results.push({
        step: stepIdx,
        type: 'parallel',
        label: step.label || `parallel-${step.subSteps.length}agents`,
        agents: parallelResults,
        failed: parallelResults.some(r => r.failed),
        duration: Math.max(...parallelResults.map(r => r.duration || 0)),
        tokens: parallelResults.reduce((sum, r) => sum + (r.tokens || 0), 0),
      });
    }

    // Pipeline step
    if (step.type === 'pipeline') {
      log(`Pipeline step — execute via fan_out or sequential processing`);
      results.push({
        step: stepIdx,
        type: 'pipeline',
        label: step.label,
        output: 'Pipeline execution requires sequential processing through stages.',
      });
    }
  }

  // ─── Output Results ──────────────────────────────────────
  const output = {
    name: workflow.name,
    status: failedSteps > 0 ? 'completed_with_errors' : 'completed',
    steps: workflow.steps?.length || 0,
    completedSteps: results.length,
    failedSteps,
    results,
    budget: {
      ...budget,
      remaining: budget.total ? Math.max(0, budget.total - budget.spent) : null,
      usagePercent: budget.total ? ((budget.spent / budget.total) * 100).toFixed(1) + '%' : 'N/A',
    },
    duration: results.reduce((sum, r) => sum + (r.duration || 0), 0),
    totalTokens: results.reduce((sum, r) => sum + (r.tokens || 0), 0),
    completedAt: new Date().toISOString(),
  };

  process.stdout.write(JSON.stringify(output, null, 2));
}

main().catch(err => {
  process.stderr.write(`Fatal error: ${err.message}\n${err.stack}\n`);
  process.stdout.write(JSON.stringify({ error: err.message, status: 'failed' }));
  process.exit(1);
});
