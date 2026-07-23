import fs = require("node:fs");
import path = require("node:path");

const root = path.resolve(__dirname, "..");
const logsDirectory = path.join(root, ".cli", "logs", "agent");
const outputPath = path.join(root, ".cli", "log-viewer.html");

function readJsonl(filePath: string): Array<Record<string, unknown>> {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).flatMap((line) => {
        if (!line.trim()) return [];
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
}

function readJson(filePath: string): Record<string, unknown> {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; } catch { return {}; }
}

const traceFiles = fs.existsSync(logsDirectory)
    ? fs.readdirSync(logsDirectory).filter((name) => /^agent-trace-\d{4}-\d{2}-\d{2}\.jsonl$/i.test(name))
    : [];
const traces = traceFiles.flatMap((name) => readJsonl(path.join(logsDirectory, name)));
const responseFiles = fs.existsSync(logsDirectory)
    ? fs.readdirSync(logsDirectory).filter((name) => /^agent-model-responses-\d{4}-\d{2}-\d{2}\.jsonl$/i.test(name))
    : [];
const responses = responseFiles.flatMap((name) => readJsonl(path.join(logsDirectory, name)));
const sessions = readJson(path.join(root, ".cli-sessions.json"));
const payload = { generatedAt: new Date().toISOString(), traces, responses, sessions };

const html = `<!doctype html>
<html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CLI Log Viewer</title>
<style>
:root{color-scheme:dark;--bg:#10131a;--panel:#191e29;--line:#30394b;--text:#e7edf8;--muted:#9ba9bd;--accent:#70b7ff;--bad:#ff8c93;--ok:#66d19e}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px system-ui,sans-serif}header{padding:20px;position:sticky;top:0;background:#10131af2;border-bottom:1px solid var(--line);z-index:2}h1{font-size:20px;margin:0 0 8px}.sub{color:var(--muted)}main{display:grid;grid-template-columns:minmax(280px,34%) 1fr;min-height:calc(100vh - 90px)}aside{border-right:1px solid var(--line);padding:14px;overflow:auto}section{padding:18px;overflow:auto}input{width:100%;padding:9px;background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:6px}.item{display:block;width:100%;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:7px;color:var(--text);padding:11px;margin:9px 0;cursor:pointer}.item:hover{border-color:var(--accent)}.meta{font-size:12px;color:var(--muted);margin-top:5px}.tag{display:inline-block;border-radius:999px;padding:2px 7px;font-size:12px;background:#26344a;color:#b9d9ff}.ok{color:var(--ok)}.error{color:var(--bad)}.event{border-left:3px solid var(--line);padding:9px 12px;margin:9px 0;background:var(--panel)}pre{white-space:pre-wrap;word-break:break-word;background:#0b0e14;padding:12px;border-radius:6px;border:1px solid var(--line);max-height:380px;overflow:auto}button{background:#263b59;border:1px solid var(--accent);color:var(--text);padding:7px 10px;border-radius:6px;cursor:pointer}details{margin:12px 0}@media(max-width:800px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line)}}
</style>
<header><h1>CLI Log Viewer</h1><div class="sub" id="summary"></div></header><main><aside><input id="filter" placeholder="ค้นหา task, action, URL, ข้อความ..."><div id="list"></div></aside><section id="detail"><p class="sub">เลือก execution task หรือ conversation session ทางซ้าย</p></section></main>
<script>const data=${JSON.stringify(payload).replace(/</g, "\\u003c")};
const byTask=new Map();for(const e of data.traces){if(!e.taskId)continue;const a=byTask.get(e.taskId)||[];a.push(e);byTask.set(e.taskId,a)}for(const a of byTask.values())a.sort((x,y)=>String(x.timestamp).localeCompare(String(y.timestamp)));
const responses=new Map();for(const e of data.responses){if(!e.taskId)continue;const a=responses.get(e.taskId)||[];a.push(e);responses.set(e.taskId,a)}
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));const pretty=x=>esc(JSON.stringify(x,null,2));
const json=value=>{try{return typeof value==='string'?JSON.parse(value):value}catch{return undefined}};
function webSummary(observation){const outer=json(observation);const content=outer?.structuredContent??json(outer?.content?.[0]?.text);if(!content?.query)return '';const attempts=(content.attempts||[]).map(a=>'<li>'+esc(a.query)+' <span class="tag">'+esc(a.provider)+' · '+esc(a.resultCount)+' candidates</span></li>').join('');const results=(content.results||[]).map(r=>'<li><a href="'+esc(r.url)+'" target="_blank" rel="noreferrer">'+esc(r.title||r.url)+'</a><div class="meta">'+esc(r.source||'')+'</div><div>'+esc(r.snippet||'')+'</div></li>').join('');return '<div><b>Web search:</b> '+esc(content.query)+' · '+esc(content.resultCount)+' usable result(s)</div>'+(attempts?'<details><summary>Search attempts</summary><ul>'+attempts+'</ul></details>':'')+(results?'<ol>'+results+'</ol>':'<div class="meta">No usable result after relevance filtering.</div>')}
function localSearchSummary(event){if(event.action!=='search_files')return '';const lines=String(event.observation||'').split(/\\r?\\n/).filter(Boolean);const matches=lines.map(line=>line.match(/^(.+?):(\\d+):\\s*([\\s\\S]*)$/)).filter(Boolean).slice(0,20);const query=event.arguments?.query||'';const items=matches.map(match=>{const file=match[1],line=match[2],snippet=match[3].replace(/\\s+/g,' ').slice(0,260);const log=/^\\.cli[\\\\/]logs[\\\\/]/i.test(file);return '<li><b>'+esc(file)+':'+esc(line)+'</b>'+(log?' <span class="tag">log file — not source evidence</span>':'')+'<div>'+esc(snippet)+'</div></li>'}).join('');return '<div><b>Local file search:</b> '+esc(query)+' · '+matches.length+(lines.length>matches.length?'+'+String(lines.length-matches.length):'')+' matching line(s)</div>'+(items?'<ol>'+items+'</ol>':'<div class="meta">No parseable file matches.</div>')}
function observationView(event){const observation=event.observation;const local=localSearchSummary(event);if(local)return local+'<details><summary>Raw tool data</summary><pre>'+esc(observation)+'</pre></details>';const web=webSummary(observation);return web?web+'<details><summary>Raw tool data</summary><pre>'+esc(observation)+'</pre></details>':'<details><summary>Tool result / observation</summary><pre>'+esc(observation)+'</pre></details>'}
function renderList(){const q=document.querySelector('#filter').value.toLowerCase();const list=document.querySelector('#list');const tasks=[...byTask.entries()].sort((a,b)=>String(b[1].at(-1)?.timestamp).localeCompare(String(a[1].at(-1)?.timestamp)));let out='<h3>Execution tasks ('+tasks.length+')</h3>';for(const[id,rows]of tasks){const text=JSON.stringify(rows).toLowerCase();if(!text.includes(q)&&!id.includes(q))continue;const start=rows[0],last=rows.at(-1);out+='<button class="item" data-task="'+esc(id)+'"><b>'+esc(id)+'</b><div class="meta">'+esc(start?.timestamp)+' · '+rows.length+' events · '+esc(last?.action||last?.status)+'</div></button>'}const ss=Array.isArray(data.sessions.sessions)?data.sessions.sessions:[];out+='<h3>Conversation sessions ('+ss.length+')</h3>';for(const s of ss){const text=JSON.stringify(s).toLowerCase();if(!text.includes(q))continue;out+='<button class="item" data-session="'+esc(s.id)+'"><b>'+esc(s.title||s.id)+'</b><div class="meta">'+esc(s.id)+' · '+(s.messages||[]).length+' messages</div></button>'}list.innerHTML=out;list.querySelectorAll('[data-task]').forEach(button=>button.addEventListener('click',()=>showTask(button.dataset.task)));list.querySelectorAll('[data-session]').forEach(button=>button.addEventListener('click',()=>showSession(button.dataset.session)))}
function showTask(id){const rows=byTask.get(id)||[];const rs=responses.get(id)||[];let out='<h2>'+esc(id)+'</h2><div class="sub">'+esc(rows[0]?.timestamp)+' — '+esc(rows.at(-1)?.timestamp)+'</div>';for(const e of rows){const cls=e.status==='error'?'error':e.status==='ok'?'ok':'';out+='<div class="event"><b class="'+cls+'">Step '+esc(e.turn)+' · '+esc(e.action||e.status)+'</b>'+(e.reason?'<div>'+esc(e.reason)+'</div>':'')+(e.arguments?'<details><summary>Tool request</summary><pre>'+pretty(e.arguments)+'</pre></details>':'')+(e.observation?observationView(e):'')+'</div>'}out+='<h3>LLM responses ('+rs.length+')</h3>'+rs.map(r=>{const action=json(r.rawContent);const usage=r.usage||{};return '<div class="event"><b>Step '+esc(r.turn)+' · '+esc(r.parsedAction||'parse error')+'</b>'+(action?.reason?'<div>'+esc(action.reason)+'</div>':'')+'<div class="meta">'+esc(r.durationMs)+' ms · prompt '+esc(usage.prompt_tokens)+' · output '+esc(usage.completion_tokens)+'</div><details><summary>Raw model response</summary><pre>'+esc(r.rawContent)+'</pre></details></div>'}).join('');document.querySelector('#detail').innerHTML=out}
function showSession(id){const s=(data.sessions.sessions||[]).find(x=>x.id===id);if(!s)return;let out='<h2>'+esc(s.title||id)+'</h2><div class="sub">'+esc(id)+' · '+esc(s.workspace||'')+'</div>';for(const m of s.messages||[])out+='<div class="event"><b class="tag">'+esc(m.role)+'</b><div>'+esc(m.content)+'</div><div class="meta">'+new Date(m.timestamp).toLocaleString()+'</div></div>';out+='<details><summary>usage</summary><pre>'+pretty(s.usage)+'</pre></details>';document.querySelector('#detail').innerHTML=out}
document.querySelector('#filter').addEventListener('input',renderList);document.querySelector('#summary').textContent='สร้าง '+new Date(data.generatedAt).toLocaleString()+' · '+data.traces.length+' trace events · '+data.responses.length+' LLM responses';renderList();
</script></html>`;
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, html, "utf8");
console.log(`Log viewer written: ${outputPath}`);
