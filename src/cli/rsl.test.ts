import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkout, mapFilter } from '../rsl/examples.ts';
import { main } from './rsl.ts';

/** Run the CLI against a scratch directory, capturing what it prints. */
async function rsl(dir: string, ...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { cwd: dir, out: (line) => void out.push(line), err: (line) => void err.push(line) });
  return { code, out, err };
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rsl-cli-'));
  await writeFile(join(dir, 'map-filter.json'), JSON.stringify(mapFilter, null, 2));
  await writeFile(join(dir, 'checkout.json'), JSON.stringify(checkout, null, 2));
  await writeFile(
    join(dir, 'parallel.json'),
    JSON.stringify({
      StartAt: 'P',
      States: { P: { Type: 'Parallel', Branches: [{ StartAt: 'A', States: { A: { Type: 'Succeed' } } }], End: true } },
    }),
  );
  await writeFile(
    join(dir, 'broken.json'),
    JSON.stringify({ StartAt: 'A', States: { A: { Type: 'Pass', Next: 'Nowhere', Bogus: 1 } } }),
  );
  await writeFile(join(dir, 'not-json.json'), '{ "StartAt": ');
  await writeFile(join(dir, 'registry.mjs'), 'export default { transforms: { double: (n) => n * 2 } };\n');
  await writeFile(join(dir, 'input.json'), '[1, 2, 3, 4, 5]\n');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('rsl: usage', () => {
  it('prints usage and exits 2 without a command, or with an unknown one', async () => {
    expect((await rsl(dir)).code).toBe(2);
    const unknown = await rsl(dir, 'frobnicate', 'map-filter.json');
    expect(unknown.code).toBe(2);
    expect(unknown.err[0]).toContain('unknown command "frobnicate"');
  });

  it('prints usage and exits 0 for help', async () => {
    const help = await rsl(dir, '--help');
    expect(help.code).toBe(0);
    expect(help.out.join('\n')).toContain('rsl <command> <document.json>');
  });

  it('requires a document path', async () => {
    const missing = await rsl(dir, 'pipe');
    expect(missing.code).toBe(2);
    expect(missing.err[0]).toContain('a document path is required');
  });
});

describe('rsl validate', () => {
  it('accepts a well-formed document, checking the schema too', async () => {
    const result = await rsl(dir, 'validate', 'map-filter.json');
    expect(result.err).toEqual([]);
    expect(result.out).toEqual(['ok: 2 states, StartAt Double']);
    expect(result.code).toBe(0);
  });

  it('lists graph issues and schema errors, and exits 1', async () => {
    const result = await rsl(dir, 'validate', 'broken.json');
    expect(result.code).toBe(1);
    expect(result.err).toContainEqual('States.A.Next: target state "Nowhere" does not exist');
    expect(result.err.some((line) => line.startsWith('schema: /States/A'))).toBe(true);
  });

  it('reports invalid JSON', async () => {
    const result = await rsl(dir, 'validate', 'not-json.json');
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain('not valid JSON');
  });
});

describe('rsl pipe and viz', () => {
  it('prints the pipe view', async () => {
    const result = await rsl(dir, 'pipe', 'map-filter.json');
    expect(result.code).toBe(0);
    expect(result.out.join('\n')).toContain('Double: map(double) → Emit');
  });

  it('prints Mermaid, or writes it as .mmd or as a page', async () => {
    const printed = await rsl(dir, 'viz', 'map-filter.json', '--direction', 'LR');
    expect(printed.code).toBe(0);
    expect(printed.out[0]).toMatch(/^flowchart LR/);

    expect((await rsl(dir, 'viz', 'map-filter.json', '--out', 'graph.mmd')).code).toBe(0);
    expect(await readFile(join(dir, 'graph.mmd'), 'utf8')).toMatch(/^flowchart TD[\s\S]*rsl_in --> m_Double/);

    expect((await rsl(dir, 'viz', 'map-filter.json', '--out', 'graph.html')).code).toBe(0);
    const html = await readFile(join(dir, 'graph.html'), 'utf8');
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain('rsl_in --&gt; m_Double');
  });

  it('rejects an unknown direction', async () => {
    const result = await rsl(dir, 'viz', 'map-filter.json', '--direction', 'UP');
    expect(result.code).toBe(2);
  });

  it('refuses a document that fails the graph rules', async () => {
    const result = await rsl(dir, 'pipe', 'broken.json');
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain('target state "Nowhere" does not exist');
  });
});

describe('rsl run', () => {
  it('pipes the input through the machine and writes the trace', async () => {
    const result = await rsl(dir, 'run', 'map-filter.json', '--registry', 'registry.mjs', '--input', 'input.json', '--trace', 'trace.json');
    expect(result.code).toBe(0);
    expect(result.out).toEqual(['8', '10']);
    expect(result.err.at(-1)).toMatch(/wrote .*trace\.json \(20 events\)/);
    const trace = JSON.parse(await readFile(join(dir, 'trace.json'), 'utf8')) as unknown[];
    expect(trace).toHaveLength(20);
    expect(trace[0]).toMatchObject({ kind: 'in', state: 'Double', tokenId: 0, value: 1 });
  });

  it('prints one trace line per event with --verbose', async () => {
    const result = await rsl(dir, 'run', 'map-filter.json', '--registry', 'registry.mjs', '--input', 'input.json', '--verbose');
    expect(result.code).toBe(0);
    expect(result.err.filter((line) => line.startsWith('drop'))).toHaveLength(3);
  });

  it('requires --registry and --input', async () => {
    expect((await rsl(dir, 'run', 'map-filter.json')).code).toBe(2);
  });

  it('fails with the runtime message for states the runtime does not implement yet', async () => {
    const result = await rsl(dir, 'run', 'parallel.json', '--registry', 'registry.mjs', '--input', 'input.json');
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain('Type "Parallel" is not implemented');
  });

  it('fails with the registry message when a resource is missing', async () => {
    const result = await rsl(dir, 'run', 'checkout.json', '--registry', 'registry.mjs', '--input', 'input.json');
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain('no resource named "validate"');
  });
});
