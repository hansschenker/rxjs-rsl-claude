import './style.css';
import mermaid from 'mermaid';
import { from, toArray } from 'rxjs';
import { compile } from './rsl/compile.ts';
import type { TraceEvent } from './rsl/compile.ts';
import { toMermaid } from './rsl/diagram.ts';
import { examples } from './rsl/examples.ts';
import type { Example } from './rsl/examples.ts';
import { toPipeView } from './rsl/pipeview.ts';

const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral' });

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header>
    <h1>RSL</h1>
    <p>
      Reactive States Language: ASL topology + RxJS execution policies.
      Each document below is rendered twice from the same data, as a topology graph
      and as the RxJS pipe each state stands for. Where the runtime already supports
      every state, the document is also run and its trace shown.
    </p>
  </header>
  <main></main>
`;
const main = app.querySelector('main')!;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Run the example through `compile` and show its output plus the per-state trace. */
function runBlock(example: Example): HTMLPreElement {
  const pre = document.createElement('pre');
  pre.className = 'run';
  const run = example.run;
  if (!run) return pre;
  const lines: string[] = [];
  const trace = (event: TraceEvent): void => {
    lines.push(`${event.kind.padEnd(5)} ${event.state.padEnd(12)} #${event.tokenId}  ${JSON.stringify(event.value)}`);
  };
  try {
    from(run.input)
      .pipe(compile(example.machine, run.registry, { trace }), toArray())
      .subscribe({
        next: (out) => {
          const result = out.map((value) => JSON.stringify(value)).join(', ');
          pre.textContent = `run: from(${JSON.stringify(run.input)}) → ${result}\n\ntrace:\n${lines.join('\n')}`;
        },
        error: (error: unknown) => {
          pre.textContent = `run error: ${String(error)}`;
        },
      });
  } catch (error) {
    pre.textContent = `compile error: ${String(error)}`;
  }
  return pre;
}

async function render(): Promise<void> {
  for (const [index, example] of examples.entries()) {
    const { name, machine } = example;
    const section = document.createElement('section');
    section.className = 'example';
    section.innerHTML = `
      <h2>${escapeHtml(name)}</h2>
      <p class="comment">${escapeHtml(machine.Comment ?? '')}</p>
      <div class="diagram"></div>
      <pre class="pipe"></pre>
      <details>
        <summary>RSL document</summary>
        <pre class="source"></pre>
      </details>
    `;
    main.append(section);
    section.querySelector<HTMLPreElement>('.pipe')!.textContent = toPipeView(machine);
    section.querySelector<HTMLPreElement>('.source')!.textContent = JSON.stringify(machine, null, 2);
    if (example.run) section.querySelector('.pipe')!.after(runBlock(example));
    const { svg } = await mermaid.render(`rsl-diagram-${index}`, toMermaid(machine));
    section.querySelector<HTMLDivElement>('.diagram')!.innerHTML = svg;
  }
}

render().catch((error: unknown) => console.error(error));
