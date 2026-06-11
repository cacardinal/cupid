#!/usr/bin/env node
// Cupid mock-launch simulator. Virtual clock drives N personas through the real
// engine on the Firebase emulators (DEMO_MODE + CLAUDE_BRIDGE_URL).
// node sim/engine.mjs --users 100 --vdays 7 --wallhours 2 --seed 42 --wave 1 [--personas file]
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a,i,arr)=>a.startsWith("--")?[a.slice(2),arr[i+1]&&!arr[i+1].startsWith("--")?arr[i+1]:true]:[]).filter(Boolean));
const USERS=+(args.users??100), VDAYS=+(args.vdays??7), WALL=+(args.wallhours??2), SEED=+(args.seed??42), WAVE=args.wave??"1";
const RATIO = (VDAYS*24*60) / (WALL*60); // virtual minutes per wall minute
const FNS="http://127.0.0.1:5001/cupid-dating-mvp/us-central1";
const FS=`http://127.0.0.1:8080/v1/projects/cupid-dating-mvp/databases/(default)/documents`;
const BRIDGE=process.env.BRIDGE_URL??"http://127.0.0.1:5599";
const CKPT=path.join(DIR,"state",`wave-${WAVE}.json`);

let s=SEED>>>0; const rnd=()=>((s=(s*1664525+1013904223)>>>0)/2**32);
const pfile=args.personas??path.join(DIR,"personas",`personas-${USERS}.jsonl`);
const personas=fs.readFileSync(pfile,"utf8").trim().split("\n").map(JSON.parse).slice(0,USERS);

// Launch curve: 50% arrive day 1-2 (exp decay), rest spread, referral bumps ignored v1
for (const p of personas) {
  const r=rnd();
  p.arrivalVmin = r<0.5 ? rnd()*2*1440 : 2*1440 + rnd()*(VDAYS-2)*1440*0.9;
  p.state={turns:0,dropped:false,lastSeen:{}};
}
const events=personas.map(p=>({t:p.arrivalVmin,type:"persona_turn",p,first:true}));
let vnow=0, lastDay=-1;
const log=(m)=>console.log(`[v${(vnow/1440).toFixed(2)}d] ${m}`);

async function outboxFor(phone, sinceIso){
  const r=await fetch(`${FS}/demo_outbox?pageSize=300`,{headers:{Authorization:"Bearer owner"}});
  const docs=(await r.json()).documents??[];
  return docs.map(d=>({to:d.fields.to.stringValue,body:d.fields.body.stringValue,at:d.fields.sentAt.timestampValue}))
    .filter(m=>m.to===phone&&(!sinceIso||m.at>sinceIso)).sort((a,b)=>a.at<b.at?-1:1);
}
async function sendInbound(phone,body){
  await fetch(`${FNS}/smsWebhook`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({From:phone,Body:body})}).catch(()=>{});
}
function personaSystem(p){
  const g=p.groundTruth,b=p.behavior;
  return `You are ${p.name}, a real ${g.age}-year-old ${g.gender} in ${g.neighborhood}, St. Louis, texting a matchmaking service called Cupid. ${p.backstory}
FACTS ABOUT YOU (reveal naturally over conversation, never all at once): age ${g.age}, ${g.occupation}, into ${g.interests.join(", ")}, values ${g.values.join(", ")}, looking for ${g.relationshipIntent}, prefers ${g.genderPreference.join("/")} ages ${g.ageMin}-${g.ageMax}${g.dealbreakers.length?`, dealbreaker: ${g.dealbreakers[0]}`:""}${g.smoker?", you smoke":""}${g.wantsKids?", you want kids someday":""}.
TEXTING STYLE: ${b.msgLen} messages${b.lowercase?", mostly lowercase":""}${b.emojiRate>0.3?", uses emojis":""}, like: "${p.sampleText}".
BEHAVE LIKE A REAL PERSON: ${b.guardedness>0.6?"guarded at first, warm up slowly":"open and chatty"}. Sometimes answer partially, ask questions back, occasionally go off topic. If asked yes/no about meeting someone, your enthusiasm depends on how appealing they sound (your bar: ${b.agreeableness}). NEVER mention being simulated. Reply with ONLY your next text message.`;
}
async function personaReply(p,history){
  const res=await fetch(BRIDGE,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"haiku",max_tokens:150,system:personaSystem(p),messages:history.length?history:[{role:"user",content:"(You just saw an ad: 'Text Cupid, the matchmaker in your texts.' Send your first message.)"}],_job:"sim-persona"})});
  if(!res.ok) throw new Error(await res.text());
  return (await res.json()).content[0].text.trim();
}
async function conversationHistory(p){
  // persona's view: Cupid msgs are "user", persona's own are "assistant"
  const msgs=await outboxFor(p.phone,null);
  const hist=[]; // we reconstruct from persona's sent log + outbox interleaved by time
  const sent=p.state.sentLog??[];
  const merged=[...msgs.map(m=>({role:"user",content:m.body,at:m.at})),...sent.map(m=>({role:"assistant",content:m.body,at:m.at}))].sort((a,b)=>a.at<b.at?-1:1);
  return merged.slice(-12).map(({role,content})=>({role,content}));
}
async function tick(ev){
  const p=ev.p;
  if(p.state.dropped) return;
  if(!ev.first && rnd()<p.behavior.dropoutHazard){ p.state.dropped=true; return; }
  try{
    const hist=await conversationHistory(p);
    if(!ev.first && hist.length && hist[hist.length-1].role==="assistant") {
      // no new Cupid message yet; re-check later
      events.push({t:vnow+30,type:"persona_turn",p}); return;
    }
    const text=await personaReply(p,hist);
    (p.state.sentLog??=[]).push({body:text,at:new Date().toISOString()});
    await sendInbound(p.phone,text);
    p.state.turns++;
    // schedule next turn after latency (and a poll buffer for Cupid's reply)
    events.push({t:vnow+p.behavior.latencyMinVirtual+20+rnd()*60,type:"persona_turn",p});
  }catch(e){ log(`persona ${p.id} err: ${String(e).slice(0,80)}`); events.push({t:vnow+60,type:"persona_turn",p}); }
}
async function dailyJobs(day){
  log(`--- virtual day ${day}: matching + dates + checkins`);
  for(const a of ["runMatching","startScheduledDates","runCheckins"]){
    try{ const r=await fetch(`${FNS}/demoAdmin?action=${a}`,{method:"POST"}); log(`${a}: ${(await r.text()).slice(0,120)}`);}catch(e){log(`${a} failed`)}
  }
  fs.writeFileSync(CKPT,JSON.stringify({vnow,day,personas:personas.map(p=>({id:p.id,state:p.state}))}));
}
// main loop: advance virtual clock in wall time
const t0=Date.now(); const endV=VDAYS*1440;
log(`wave ${WAVE}: ${USERS} users, ${VDAYS} vdays in ${WALL}h wall (ratio ${RATIO.toFixed(0)}x)`);
while(vnow<endV){
  vnow=((Date.now()-t0)/60000)*RATIO;
  const day=Math.floor(vnow/1440);
  if(day>lastDay){ lastDay=day; if(day>0) await dailyJobs(day); }
  const due=events.filter(e=>e.t<=vnow); 
  for(const e of due){ events.splice(events.indexOf(e),1); }
  await Promise.all(due.slice(0,12).map(tick)); // cap burst
  for(const e of due.slice(12)) events.push({...e,t:vnow+5});
  if(!due.length) await new Promise(r=>setTimeout(r,1500));
}
await dailyJobs(VDAYS);
const alive=personas.filter(p=>!p.state.dropped).length;
log(`DONE. turns=${personas.reduce((a,p)=>a+p.state.turns,0)} active=${alive}/${USERS}`);
