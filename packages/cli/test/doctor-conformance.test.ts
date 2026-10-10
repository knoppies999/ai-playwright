import { resolveConfig } from '@aipw/core';
import { describe, expect, it } from 'vitest';
import { conformanceMetrics, parseConformanceArgs } from '../src/conformance.js';
import { doctorChecks } from '../src/doctor.js';

const all = () => true;
const statusOf = (checks: { status: string; label: string }[], label: string) =>
  checks.find((c) => c.label === label)?.status;

describe('aipw doctor (no network)', () => {
  it('claude-code: warns when ANTHROPIC_API_KEY would bill a key instead of the subscription', () => {
    const config = resolveConfig({});
    expect(statusOf(doctorChecks(config, {}, { resolvable: all }), 'subscription')).toBe('ok');
    expect(statusOf(doctorChecks(config, { ANTHROPIC_API_KEY: 'k' }, { resolvable: all }), 'ANTHROPIC_API_KEY')).toBe(
      'warn',
    );
  });

  it('foundry: needs the resource and deployment; keyless needs @azure/identity', () => {
    const config = resolveConfig({});
    const missing = doctorChecks(config, {}, { provider: 'foundry', resolvable: (p) => p !== '@azure/identity' });
    expect(missing.filter((c) => c.status === 'fail').map((c) => c.label)).toEqual([
      'AZURE_FOUNDRY_RESOURCE',
      'AIPW_FOUNDRY_DEPLOYMENT',
      'auth',
    ]);
    const keyed = doctorChecks(
      config,
      { AZURE_FOUNDRY_RESOURCE: 'r', AIPW_FOUNDRY_DEPLOYMENT: 'd', AZURE_FOUNDRY_API_KEY: 'k' },
      { provider: 'foundry', resolvable: all },
    );
    expect(keyed.filter((c) => c.status === 'fail')).toEqual([]);
  });

  it('flags a missing provider package, missing secrets and missing budgets', () => {
    const config = resolveConfig({ secrets: { map: { password: 'TEST_PASSWORD' } } });
    const checks = doctorChecks(config, {}, { provider: 'copilot', resolvable: () => false });
    expect(statusOf(checks, 'provider')).toBe('fail');
    expect(statusOf(checks, 'copilot')).toBe('fail');
    expect(statusOf(checks, 'secret password')).toBe('warn');
    expect(statusOf(checks, 'budget')).toBe('warn');
    expect(doctorChecks(config, {}, { provider: 'nope' })).toEqual([
      { status: 'fail', label: 'provider', detail: '"nope" is not a known provider; add it under "providers"' },
    ]);
  });
});

describe('aipw conformance metrics', () => {
  const step = (status: 'passed' | 'failed', decisions: number, ms: number, repairs = 0) => ({
    status,
    decisions,
    repairs,
    decisionMs: Array(decisions).fill(ms / Math.max(decisions, 1)),
    ms,
    usage: { inputTokens: 1000 * decisions, outputTokens: 50 * decisions, requests: decisions },
  });

  it('computes success rate, efficiency, repairs, tokens and latency percentiles', () => {
    const metrics = conformanceMetrics(
      [
        {
          test: 'a',
          provider: 'foundry',
          model: 'e2e-agent',
          steps: [step('passed', 2, 8000), step('passed', 1, 3000, 1)],
        },
        {
          test: 'b',
          provider: 'foundry',
          model: 'e2e-agent',
          steps: [step('passed', 3, 12000), step('failed', 4, 20000)],
        },
      ],
      new Date('2026-10-10T00:00:00Z'),
    );
    expect(metrics).toEqual({
      provider: 'foundry',
      model: 'e2e-agent',
      date: '2026-10-10',
      tests: 2,
      steps: 4,
      stepSuccessRate: 0.75,
      meanDecisionsPerStep: 2.5,
      repairTurns: 1,
      tokensPerStep: { input: 2500, output: 125 },
      requestsPerStep: 2.5,
      decisionLatencyMs: { p50: 4000, p95: 5000 },
      stepLatencyMs: { p50: 8000, p95: 20000 },
    });
  });

  it('parses arguments', () => {
    expect(parseConformanceArgs(['--provider', 'foundry'])).toEqual({
      provider: 'foundry',
      project: 'saucedemo-llm',
      out: 'docs/conformance',
    });
    expect(parseConformanceArgs([])).toMatchObject({ error: expect.stringContaining('Usage') });
  });
});
