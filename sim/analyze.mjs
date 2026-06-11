#!/usr/bin/env node
// Wave analysis: funnel, extraction accuracy vs ground truth, match quality, voice audit.
// node sim/analyze.mjs --wave 1 --personas sim/personas/personas-100.jsonl [--judge 0]
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const DIR=path.dirname(fileURLToPath(import.meta.url));
const args=Object.fromEntries(process.argv.slice(2).map((a,i,arr)=>a.startsWith("--")?[a.slice(2),arr[i+1]&&!arr[i+1].startsWith("--")?arr[i+1]:true]:[]).filter(Boolean));
const WAVE=args.wave??"1", JUDGE=+(args.judge??10);
const FS=`http://127.0.0.1:8080/v1/projects/cupid-dating-mvp/databases/(default)/documents`;
const BRIDGE=process.env.BRIDGE_URL??"http://127.0.0.1:5599";
const H={Authorization:"Bearer owner"};
const personas=fs.readFileSync(args.personas).toString().trim().split("\n").map(JSON.parse);
const dec=(f)=>{const o={};for(const[k,v]of Object.entries(f??{})){o[k]=v.stringValue??(v.integerValue&&+v.integerValue)??v.booleanValue??(v.arrayValue?(v.arrayValue.values??[]).map(x=>x.stringValue):v.mapValue?dec(v.mapValue.fields):null);}return o;};
const sha=async(t)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t)))].map(b=>b.toString(16).padStart(2,"0")).join("");

const users=(await(await fetch(`${FS}/users?pageSize=300`,{headers:H})).json()).documents?.map(d=>({id:d.name.split("/").pop(),...dec(d.fields)}))??[];
const outbox=(await(await fetch(`${FS}/demo_outbox?pageSize=300`,{headers:H})).json()).documents?.map(d=>dec(d.fields))??[];
const byHash={}; for(const p of personas){p.hash=await sha(p.phone);byHash[p.hash]=p;}
const simUsers=users.filter(u=>byHash[u.id]);

// Funnel
const funnel={arrived:personas.length,profileCreated:simUsers.length,onboarded:simUsers.filter(u=>u.onboardingComplete).length};
let matched=0,accepted=0,scheduled=0,dated=0,exchanged=0,oracle=[],violations=0;
const { computeCompatibility } = await import("../functions/lib/scheduler/matchingJob.js");
for(const u of simUsers){
  const ms=(await(await fetch(`${FS}/users/${u.id}/matches?pageSize=20`,{headers:H})).json()).documents?.map(d=>dec(d.fields))??[];
  if(ms.length)matched++;
  for(const m of ms){
    if(m.userAccepted)accepted++;
    if(["scheduled","video_sent","video_expired","contact_shared","contact_declined"].includes(m.status))scheduled++;
    if(["video_expired","contact_shared","contact_declined"].includes(m.status))dated++;
    if(m.status==="contact_shared")exchanged++;
    const other=byHash[m.matchedUserId];
    if(other){
      const gt=(p)=>({phoneHash:p.hash,demographics:{age:p.groundTruth.age,gender:p.groundTruth.gender,city:"st. louis"},preferences:{ageMin:p.groundTruth.ageMin,ageMax:p.groundTruth.ageMax,genderPreference:p.groundTruth.genderPreference,relationshipIntent:p.groundTruth.relationshipIntent,dealbreakers:p.groundTruth.dealbreakers},personality:{interests:p.groundTruth.interests,values:p.groundTruth.values,humorStyle:p.groundTruth.humorStyle,communicationStyle:p.groundTruth.communicationStyle,personalityTraits:p.groundTruth.smoker?["smoker"]:[],wantsKids:p.groundTruth.wantsKids}});
      const r=computeCompatibility(gt(byHash[u.id]),gt(other));
      oracle.push(r.score); if(!r.passed)violations++;
    }
  }
}
// Extraction accuracy
const acc={age:[0,0],relationshipIntent:[0,0],interests:[],dealbreakers:[0,0]};
for(const u of simUsers){const p=byHash[u.id],g=p.groundTruth;
  if(u.demographics?.age){acc.age[1]++;if(+u.demographics.age===g.age)acc.age[0]++;}
  if(u.preferences?.relationshipIntent){acc.relationshipIntent[1]++;if(u.preferences.relationshipIntent===g.relationshipIntent)acc.relationshipIntent[0]++;}
  const ei=(Array.isArray(u.personality?.interests)?u.personality.interests:[]).map(x=>x.toLowerCase()),gi=g.interests.map(x=>x.toLowerCase());
  if(ei.length){const inter=ei.filter(x=>gi.some(y=>y.includes(x)||x.includes(y))).length;acc.interests.push(inter/Math.max(ei.length,1));}
  if(g.dealbreakers.length){acc.dealbreakers[1]++;if((Array.isArray(u.preferences?.dealbreakers)?u.preferences.dealbreakers:[]).length)acc.dealbreakers[0]++;}
}
// Voice audit
const cupidMsgs=outbox.filter(m=>byHash[Object.values(byHash).find(p=>p.phone===m.to)?.hash]??Object.values(byHash).some(p=>p.phone===m.to)).map(m=>m.body);
const AIISMS=/(I'd be happy to|great question|absolutely!|I appreciate|feel free|dive in)/i;
const voice={msgs:cupidMsgs.length,emdash:cupidMsgs.reduce((a,m)=>a+(m.match(/[—–]/g)??[]).length,0),aiisms:cupidMsgs.filter(m=>AIISMS.test(m)).length,avgLen:Math.round(cupidMsgs.reduce((a,m)=>a+m.length,0)/Math.max(cupidMsgs.length,1))};
// Judge sample
let judgeAvg="n/a";
if(JUDGE>0&&cupidMsgs.length){
  const sample=cupidMsgs.slice(0,JUDGE).map((m,i)=>`${i+1}. "${m.slice(0,200)}"`).join("\n");
  try{const r=await fetch(BRIDGE,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"sonnet",max_tokens:300,system:"You judge SMS copy against a voice guide: friend-not-assistant, no AI-isms, contractions, short, specific, max 1 emoji, never explains itself. Score each message 1-5. Reply ONLY with JSON: {\"scores\":[...],\"worst\":\"quote the worst one\",\"note\":\"one sentence\"}",messages:[{role:"user",content:sample}],_job:"sim-judge"})});
  const j=JSON.parse((await r.json()).content[0].text.match(/\{[\s\S]*\}/)[0]);judgeAvg=(j.scores.reduce((a,b)=>a+b,0)/j.scores.length).toFixed(2)+` | worst: ${j.worst?.slice(0,120)} | ${j.note}`;}catch(e){judgeAvg="judge failed: "+String(e).slice(0,60)}
}
const pct=(x)=>x[1]?`${Math.round(100*x[0]/x[1])}% (${x[0]}/${x[1]})`:"n/a";
const report=`# Wave ${WAVE} Report (${new Date().toISOString().slice(0,16)})
## Funnel
arrived ${funnel.arrived} -> profiles ${funnel.profileCreated} -> onboarded ${funnel.onboarded} -> matched ${matched} -> accepted ${accepted} -> scheduled ${scheduled} -> dated ${dated} -> exchanged ${exchanged}
## Extraction accuracy (vs ground truth)
age exact: ${pct(acc.age)} | intent: ${pct(acc.relationshipIntent)} | interests precision avg: ${acc.interests.length?Math.round(100*acc.interests.reduce((a,b)=>a+b,0)/acc.interests.length)+"%":"n/a"} | dealbreaker captured: ${pct(acc.dealbreakers)}
## Match quality
proposed pairs oracle scores: ${oracle.length?`avg ${Math.round(oracle.reduce((a,b)=>a+b,0)/oracle.length)} min ${Math.min(...oracle)} max ${Math.max(...oracle)}`:"none"} | dealbreaker violations: ${violations} (MUST be 0)
## Voice audit (${voice.msgs} Cupid msgs)
em/en dashes: ${voice.emdash} (MUST be 0) | AI-isms: ${voice.aiisms} | avg length: ${voice.avgLen} chars
judge (${JUDGE} sampled): ${judgeAvg}
`;
const out=path.join(DIR,"reports",`wave-${WAVE}.md`);
fs.writeFileSync(out,report); console.log(report); console.log("->",out);
