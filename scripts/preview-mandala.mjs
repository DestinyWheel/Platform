/**
 * 插件前端的视觉预览：把一个游戏的 client 打成一个页面，用 headless Chrome 截图。
 *
 * 为什么要这个：插件的 UI 是运行时注入的，跑起来才看得见；但"看"这件事不该要求
 * 先起服务、登录、开桌、打到某个局面。这里直接喂假快照，一秒看到结果。
 *
 * 用法：node scripts/preview-mandala.mjs
 * 依赖：本机装了 Chrome 或 Edge（找不到就只输出 html，自己打开看）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(repoRoot, '.preview');
mkdirSync(outDir, { recursive: true });

// esbuild 是 server 包的依赖，不在仓库根；按 smoke 的做法从那边解析
const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { build } = requireFromServer('esbuild');

const bundle = await build({
  entryPoints: [path.join(repoRoot, 'games', 'mandala', 'src', 'client.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'GamePlugin',
  write: false,
  target: 'es2020',
  absWorkingDir: repoRoot,
});
writeFileSync(path.join(outDir, 'bundle.js'), bundle.outputFiles[0].text);

const players = [
  { id: 'p1', name: '爱丽丝', seat: 0, bot: false },
  { id: 'p2', name: '鲍勃', seat: 1, bot: false },
];

function view(mandalas, extra = {}) {
  return {
    phase: 'play',
    players: ['p1', 'p2'],
    turn: 'p1',
    round: 3,
    finished: false,
    ranking: null,
    data: {
      colors: [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: '' })),
      deckRemaining: 21,
      deckExhausted: false,
      mandalas,
      players: [
        { id: 'p1', name: '爱丽丝', handCount: 6, cupCount: 2, river: [3, null, null, null, null, null], cup: null },
        { id: 'p2', name: '鲍勃', handCount: 6, cupCount: 2, river: [2, 5, null, null, null, null], cup: null },
      ],
      you: {
        id: 'p1',
        name: '爱丽丝',
        handCount: 6,
        cupCount: 2,
        river: [3, null, null, null, null, null],
        cup: [3, 3, 5],
        hand: [1, 4, 6, 2, 5, 3],
      },
      opponent: {
        id: 'p2',
        name: '鲍勃',
        handCount: 6,
        cupCount: 2,
        river: [2, 5, null, null, null, null],
        cup: null,
      },
      settlement: null,
      scores: null,
      undoCount: 2,
      untimed: false,
      revealed: false,
      ...extra,
    },
  };
}

/** 注意：假数据必须遵守"一色只在一个区域"，否则预览出来是个非法局面 */
const sceneNormal = view([
  { fields: [{ 1: 2, 5: 1 }, { 2: 3 }], mountain: { 3: 2, 6: 1 }, colorCount: 5 },
  { fields: [{ 3: 1 }, { 6: 2 }], mountain: { 2: 1, 4: 1 }, colorCount: 4 },
]);

const sceneSettle = view(
  [
    { fields: [{ 1: 2, 5: 1 }, { 2: 3 }], mountain: { 3: 1, 4: 2, 6: 1 }, colorCount: 5 },
    { fields: [{ 3: 1 }, { 6: 2 }], mountain: { 2: 1 }, colorCount: 3 },
  ],
  { settlement: { mandalaIdx: 0, picker: 'p1' }, scores: { p1: 12, p2: 9 } },
);

const scenes = [
  { name: 'mandala', snapshot: { status: 'playing', legal: [], legalMoves: [], deadlineAt: null, view: sceneNormal } },
  {
    name: 'mandala-settle',
    snapshot: { status: 'playing', legal: [], legalMoves: [], deadlineAt: null, view: sceneSettle },
  },
  {
    // 选中手里第一张（红），看落子高亮对不对
    name: 'mandala-hover',
    selectCard: 0,
    snapshot: {
      status: 'playing',
      legal: ['playMountain'],
      deadlineAt: null,
      legalMoves: [
        { type: 'playMountain', payload: { card: 0, mandala: 0 } },
        { type: 'playMountain', payload: { card: 0, mandala: 1 } },
      ],
      view: sceneNormal,
    },
  },
];

const chromeCandidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const chrome = chromeCandidates.find((candidate) => existsSync(candidate));

for (const scene of scenes) {
  const html = `<!doctype html>
<meta charset="utf-8" />
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0e1116; font-family: ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  #host { width: 900px; padding: 16px; }
</style>
<div id="host"></div>
<script src="./bundle.js"></script>
<script>
  const client = GamePlugin.default ?? GamePlugin.client;
  const host = document.getElementById('host');
  client.mount({ root: host, me: 'p1', players: ${JSON.stringify(players)}, send: (a) => console.log('send', JSON.stringify(a)) });
  client.update(${JSON.stringify(scene.snapshot)});
  ${
    scene.selectCard === undefined
      ? ''
      : `document.querySelector('[data-card="${scene.selectCard}"]')?.click();`
  }
</script>
`;

  const htmlPath = path.join(outDir, `${scene.name}.html`);
  writeFileSync(htmlPath, html);

  if (!chrome) continue;

  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--user-data-dir=${path.join(outDir, 'chrome-profile')}`,
      `--screenshot=${path.join(outDir, `${scene.name}.png`)}`,
      '--window-size=940,1000',
      `file:///${htmlPath.replace(/\\/g, '/')}`,
    ],
    { stdio: 'ignore' },
  );
  console.log(`已输出 .preview/${scene.name}.png`);
}

if (!chrome) console.log(`没有找到 Chrome/Edge，用浏览器打开 ${outDir} 里的 html`);
