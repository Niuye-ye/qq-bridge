
const fs = require('fs'); const path = require('path');
const roots = ['F:/qq-bridge/src', 'F:/qq-bridge/pet-electron', 'F:/qq-bridge/scripts'];
const files = [];
function walk(d){ let es=[]; try{es=fs.readdirSync(d,{withFileTypes:true});}catch{return;} for(const e of es){ const p=path.join(d,e.name); if(e.isDirectory()){ if(e.name==='node_modules') continue; walk(p);} else if(/\.(js|mjs)$/.test(e.name)) files.push(p); } }
roots.forEach(walk);
const out = [];
for(const f of files){
  const s = fs.readFileSync(f,'utf8');
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\(/g; let m;
  while((m=re.exec(s))){
    const name = m[1];
    const defLine = s.slice(0, m.index).split('\n').length;
    let i = s.indexOf('{', m.index); if(i<0) continue;
    let depth=0, end=i;
    for(let j=i;j<s.length;j++){ const c=s[j]; if(c==='{')depth++; else if(c==='}'){ depth--; if(depth===0){ end=j; break; } } }
    const body = s.slice(i, end+1);
    const callRe = new RegExp('(^|[^\\w$.])' + name.replace(/\$/g,'\\$') + '\\s*\\(', 'g');
    let c2; const lines=[];
    while((c2 = callRe.exec(body))){ lines.push(defLine + (body.slice(0,c2.index).match(/\n/g)||[]).length); }
    if(lines.length) out.push({ f: f.replace('F:/qq-bridge/',''), fn: name, defLine, at: lines.join(',') });
  }
}
console.log('自引用候选 ' + out.length + ' 个');
for(const x of out) console.log(x.f + ' :: ' + x.fn + ' def@' + x.defLine + ' self@' + x.at);
