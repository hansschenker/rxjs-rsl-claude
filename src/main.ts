import './style.css';
import mermaid from 'mermaid';
import { toMermaid } from './rsl/diagram.ts';
import { examples } from './rsl/examples.ts';
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
      and as the RxJS pipe each state stands for.
    </p>
  </header>
  <main></main>
`;
const main = app.querySelector('main')!;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function render(): Promise<void> {
  for (const [index, { name, machine }] of examples.entries()) {
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
    const { svg } = await mermaid.render(`rsl-diagram-${index}`, toMermaid(machine));
    section.querySelector<HTMLDivElement>('.diagram')!.innerHTML = svg;
  }
}

render().catch((error: unknown) => console.error(error));
