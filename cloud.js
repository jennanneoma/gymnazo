/* cloud.js: the online part of Gymnazo.
   - accounts: sign up, log in, log out, forgot password
   - keeping everyone's data in one online database (Supabase), so a coach and a client
     see the same thing on different phones

   How saving works, in short:
   1. save() writes to this phone first, so the app feels instant and works with no signal
   2. a moment later push() sends only the records that changed
   3. every record has a version number. If someone else saved it in between (say the coach edited
      the routine while the client was logging), we fetch theirs, combine both sets of changes
      (merge3), and try again. Nobody's changes get lost.

   Until CLOUD.url and CLOUD.key are filled in, none of this runs and the app is the demo with sample data. */

// From Supabase: Project URL, and the publishable key (it's made to be public, the database rules keep data safe).
// Never put the secret key here.
const CLOUD={url:'https://erzwotxoobagawwydbtn.supabase.co',key:'sb_publishable_qHkaDs8Ndmxc5xKjTGBDTA_0FYuDskq'};
const LIVE_URL='https://jennanneoma.github.io/gymnazo/';
const cloudReady=()=>!!(CLOUD.url&&CLOUD.key&&typeof supabase!=='undefined'&&supabase.createClient);
// where email links (confirm, reset password) bring people back to
const appUrl=()=>{try{const o=location.origin;return o&&o!=='null'?o+location.pathname:LIVE_URL}catch(e){return LIVE_URL}};

const cloud={on:false,db:null,user:null,meta:{},busy:false,again:false,state:'ok',retryT:null,pushT:null,pullT:null};
const CACHE_KEY='gymnazo-cloud-v1';

/* ---------- the tables, and how a row turns into what the app uses ----------
   Each row has its own columns (who owns it, which coach) plus "data", which is the record as the app knows it.
   LOCAL_ONLY: things that stay on this phone and never go up (videos are too big for now). */
const TABLES=['coaches','clients','templates','exercises','photos']; // this order matters: coaches before their clients
const OMIT={coaches:['id'],clients:['id','coachId','status','inviteCode','photos','solo'],templates:['id','coachId'],exercises:['id','video','custom'],photos:['id','clientId']};
const LOCAL_ONLY={clients:['photos'],exercises:['video']};
const stable=o=>JSON.stringify(o,(k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().reduce((a,x)=>(a[x]=v[x],a),{}):v);
const same=(a,b)=>stable(a)===stable(b);
function dataOf(t,rec){const d={};for(const k in rec)if(!OMIT[t].includes(k)&&rec[k]!==undefined)d[k]=rec[k];return d}
// the record without its phone-only bits: this is what we compare to spot changes
function core(t,rec){const o={...rec};for(const k of LOCAL_ONLY[t]||[])delete o[k];return clone(o)}
function fromRow(t,r){const d=r.data||{};
  if(t==='clients'){const o={...d,id:r.id,coachId:r.coach_id||null,status:r.status,solo:!r.coach_id};if(r.invite_code)o.inviteCode=r.invite_code;else delete o.inviteCode;return o}
  if(t==='templates')return{...d,id:r.id,coachId:r.coach_id};
  if(t==='exercises')return{...d,id:r.id,custom:true};
  if(t==='photos')return{...d,id:r.id,clientId:r.client_id};
  return{...d,id:r.id};
}
function toRow(t,rec,isNew){const me=cloud.user.id,row={id:rec.id,data:dataOf(t,rec)};
  if(t==='coaches'&&isNew)row.user_id=me;
  if(t==='clients'){row.coach_id=rec.coachId||null;row.invite_code=rec.status==='invited'?rec.inviteCode||null:null;
    if(isNew){const inv=rec.status==='invited';row.user_id=inv?null:me;row.status=inv?'invited':'active'}}
  if(t==='templates')row.coach_id=rec.coachId;
  if(t==='exercises'&&isNew)row.user_id=me;
  if(t==='photos')row.client_id=rec.clientId;
  return row;
}
// which of the records in S belong to each table
function listOf(t){
  if(t==='coaches')return S.coaches;
  if(t==='clients')return S.clients;
  if(t==='templates')return S.templates;
  if(t==='exercises')return S.exercises.filter(e=>e.custom);
  return S.clients.filter(c=>(cloud.meta['clients:'+c.id]||{}).mine!==false).flatMap(c=>(c.photos||[]).map(p=>({...p,clientId:c.id})));
}
function findLocal(t,id){
  if(t!=='photos')return listOf(t).find(x=>x.id===id);
  for(const c of S.clients){const p=(c.photos||[]).find(x=>x.id===id);if(p)return{...p,clientId:c.id}}
}
// can I change this row? (I can read my coach's profile and their exercises, but not change them)
function canWrite(t,row){const me=cloud.user.id;
  if(t==='coaches'||t==='exercises')return row.user_id===me;
  if(t==='photos'){const m=cloud.meta['clients:'+row.client_id];return !!(m&&m.mine)}
  return true; // any client row or template I can see, I'm allowed to edit
}
// put a fresh copy into S, keeping the same object so nothing on screen loses track of it
function putLocal(t,next){
  next=clone(next); // a copy of its own, so changing it on screen can't quietly change our "last synced" copy too
  if(t==='photos'){const c=client(next.clientId);if(!c)return;const p={...next};delete p.clientId;c.photos=c.photos||[];const i=c.photos.findIndex(x=>x.id===p.id);if(i<0)c.photos.push(p);else c.photos[i]=p;return}
  const list=t==='exercises'?S.exercises:listOf(t),cur=list.find(x=>x.id===next.id);
  if(!cur){if(t==='clients')next.photos=next.photos||[];list.push(next);return}
  const keep={};for(const k of LOCAL_ONLY[t]||[])if(k in cur)keep[k]=cur[k];
  for(const k of Object.keys(cur))delete cur[k];Object.assign(cur,next,keep);
  if(t==='clients'&&!cur.photos)cur.photos=[];
}
function dropLocal(t,id){
  delete cloud.meta[t+':'+id];
  if(t==='photos'){for(const c of S.clients)if(c.photos)c.photos=c.photos.filter(p=>p.id!==id);return}
  if(t==='coaches')S.coaches=S.coaches.filter(x=>x.id!==id);
  if(t==='clients')S.clients=S.clients.filter(x=>x.id!==id);
  if(t==='templates')S.templates=S.templates.filter(x=>x.id!==id);
  if(t==='exercises')S.exercises=S.exercises.filter(x=>x.id!==id);
}

/* ---------- combining two people's changes ----------
   b = how it looked when we last synced, l = ours now, r = theirs now.
   Lists of things with ids (workouts, messages, notes...) are combined item by item,
   objects key by key. If both changed the very same value, ours (the newest save) wins. */
function merge3(b,l,r){
  if(same(l,b))return clone(r);
  if(same(r,b)||same(l,r))return clone(l);
  const isObj=x=>x&&typeof x==='object'&&!Array.isArray(x);
  if(Array.isArray(l)&&Array.isArray(r)){
    const key=x=>isObj(x)?(x.id!=null?'id:'+x.id:x.ts!=null?'ts:'+x.from+'|'+x.ts:null):null;
    const bl=Array.isArray(b)?b:[];
    if(![...bl,...l,...r].every(x=>key(x)))return clone(l); // a plain list (like sets in a workout): keep ours whole
    const B=new Map(bl.map(x=>[key(x),x])),L=new Map(l.map(x=>[key(x),x])),R=new Set(r.map(key)),out=[];
    for(const x of r){const k=key(x);if(B.has(k)&&!L.has(k))continue;out.push(L.has(k)?merge3(B.get(k),L.get(k),x):clone(x))} // skip what we deleted
    for(const x of l){const k=key(x);if(!R.has(k)&&!B.has(k))out.push(clone(x))} // add what we added
    return out;
  }
  if(isObj(l)&&isObj(r)){const bb=isObj(b)?b:{},out={};
    for(const k of new Set([...Object.keys(r),...Object.keys(l)])){
      const inL=k in l,inR=k in r,inB=k in bb;
      if(!inL&&inB){if(!same(r[k],bb[k]))out[k]=clone(r[k]);continue} // we removed it: stays removed unless they changed it
      if(!inR&&inB){if(!same(l[k],bb[k]))out[k]=clone(l[k]);continue}
      out[k]=inL&&inR?merge3(bb[k],l[k],r[k]):clone(inL?l[k]:r[k]);
    }
    return out;
  }
  return clone(l);
}

/* ---------- keeping a copy on this phone ----------
   So the app opens instantly and works offline. "base" (what the server last had) is only kept
   for records with changes that haven't gone up yet, which keeps the copy small. */
function cloudSaveLocal(){
  if(!cloud.on)return;
  const meta={};for(const[k,m]of Object.entries(cloud.meta)){const t=k.split(':')[0],rec=findLocal(t,k.slice(t.length+1));
    meta[k]={v:m.v,mine:m.mine,own:m.own,user:m.user,...(rec&&!same(core(t,rec),m.base)?{base:m.base}:{})}}
  try{localStorage.setItem(CACHE_KEY,JSON.stringify({uid:cloud.user.id,email:cloud.user.email,S,meta,user:ui.user}))}
  catch(e){try{localStorage.removeItem(CACHE_KEY)}catch(x){}} // phone storage full: it still works, it just loads from the internet next time
}
function cloudReadLocal(){
  let c=null;try{c=JSON.parse(localStorage.getItem(CACHE_KEY))}catch(e){}
  if(!c||!c.S||!c.uid)return null;
  S=c.S;cloud.user={id:c.uid,email:c.email};cloud.meta=c.meta||{};
  for(const[k,m]of Object.entries(cloud.meta)){if(m.base)continue;const t=k.split(':')[0],rec=findLocal(t,k.slice(t.length+1));m.base=rec?core(t,rec):null}
  return c;
}
function cloudForget(){cloud.meta={};cloud.user=null;cloud.on=false;try{localStorage.removeItem(CACHE_KEY);localStorage.removeItem('gymnazo-user')}catch(e){}}
const emptyS=()=>({v:16,online:true,coaches:[],clients:[],templates:[],exercises:baseExercises()});

/* ---------- sending changes up ---------- */
// called by save(): wait a moment so a burst of taps goes up as one
function cloudQueue(){if(!cloud.on)return;clearTimeout(cloud.pushT);cloud.pushT=setTimeout(()=>cloudPush(),700)}
async function cloudPush(){
  if(!cloud.on||!cloud.db)return;
  if(cloud.busy){cloud.again=true;return}
  cloud.busy=true;
  try{
    for(const t of TABLES){
      const seen=new Set();
      for(const rec of listOf(t)){seen.add(rec.id);const m=cloud.meta[t+':'+rec.id];
        try{
          if(!m)await sendNew(t,rec);
          else if(m.own&&!same(core(t,rec),m.base))await sendChange(t,rec,m);
        }catch(e){if(isOffline(e))throw e;refused(t,rec,e)}
      }
      for(const k of Object.keys(cloud.meta)){if(!k.startsWith(t+':'))continue;const id=k.slice(t.length+1),m=cloud.meta[k];
        if(!seen.has(id)&&m.own){try{await sendRemove(t,id,m)}catch(e){if(isOffline(e))throw e;console.warn('Gymnazo sync:',e.message);delete cloud.meta[k]}}}
    }
    cloud.state='ok';clearTimeout(cloud.retryT);
  }catch(e){
    // no signal or a hiccup: everything is still on the phone, so just try again soon
    cloud.state=isOffline(e)?'offline':'error';console.warn('Gymnazo sync:',e&&e.message||e);
    clearTimeout(cloud.retryT);cloud.retryT=setTimeout(()=>cloudPush(),15000);
  }finally{cloud.busy=false;cloudSaveLocal();if(cloud.again){cloud.again=false;cloudQueue()}}
}
async function sendNew(t,rec){
  const {data,error}=await cloud.db.from(t).insert(toRow(t,rec,true)).select(t==='clients'||t==='coaches'||t==='exercises'?'version,user_id':'version');
  if(error){if(error.code==='23505'){cloud.meta[t+':'+rec.id]={v:-1,base:{},own:true};return sendChange(t,rec,cloud.meta[t+':'+rec.id])}throw error} // it's already up there (an earlier send whose answer got lost)
  const row=(data||[])[0]||{};cloud.meta[t+':'+rec.id]={v:row.version||0,base:core(t,rec),own:true,mine:t!=='clients'||row.user_id===cloud.user.id,user:row.user_id||null};
}
async function sendChange(t,rec,m){
  for(let tries=0;tries<5;tries++){
    const row=toRow(t,rec,false);row.version=m.v+1;
    const {data,error}=await cloud.db.from(t).update(row).eq('id',rec.id).eq('version',m.v).select('version');
    if(error)throw error;
    if(data&&data.length){m.v=data[0].version;m.base=core(t,rec);return}
    // someone else saved first: get theirs, combine with ours, try again
    const got=await cloud.db.from(t).select('*').eq('id',rec.id);
    if(got.error)throw got.error;
    if(!got.data.length){dropLocal(t,rec.id);return} // it's gone (deleted, or this person left their coach)
    const remote=fromRow(t,got.data[0]);
    putLocal(t,merge3(m.base,core(t,rec),remote));rec=findLocal(t,rec.id);
    m.v=got.data[0].version;m.base=remote;
  }
  throw new Error('Too many saves at once. Trying again soon.');
}
// the database said no to a change (its safety rules). Stop retrying it and take the server's copy on the next fetch
function refused(t,rec,e){
  console.warn('Gymnazo sync: a change was refused',t,rec.id,e&&e.message);
  const m=cloud.meta[t+':'+rec.id];
  if(m){m.base=core(t,rec);m.v=-1}else cloud.meta[t+':'+rec.id]={v:-1,base:core(t,rec),own:false};
}
async function sendRemove(t,id,m){
  // a coach removing someone with an account: they keep their history and carry on alone
  if(t==='clients'&&m.user&&!m.mine){const {error}=await cloud.db.rpc('release_client',{p_id:id});if(error)throw error}
  else{const {error}=await cloud.db.from(t).delete().eq('id',id);if(error)throw error}
  delete cloud.meta[t+':'+id];
}
const isOffline=e=>!navigator.onLine||/fetch|network|load failed/i.test(String(e&&e.message||e));

/* ---------- bringing changes down ---------- */
async function cloudPull(){
  if(!cloud.on||!cloud.db)return false;
  const before=stable([S.coaches,S.clients,S.templates]);
  const main=await Promise.all(['coaches','clients','templates','exercises'].map(t=>cloud.db.from(t).select('*')));
  for(const r of main)if(r.error)throw r.error;
  main.forEach((r,i)=>apply(['coaches','clients','templates','exercises'][i],r.data,r.data.map(x=>x.id)));
  // photos are the heavy part: get the list first, then only the new or changed ones
  const list=await cloud.db.from('photos').select('id,client_id,version');
  if(list.error)throw list.error;
  const need=list.data.filter(p=>{const m=cloud.meta['photos:'+p.id];return !m||m.v!==p.version}).map(p=>p.id),rows=[];
  for(let i=0;i<need.length;i+=40){const r=await cloud.db.from('photos').select('*').in('id',need.slice(i,i+40));if(r.error)throw r.error;rows.push(...r.data)}
  apply('photos',rows,list.data.map(p=>p.id));
  cloudSaveLocal();
  return before!==stable([S.coaches,S.clients,S.templates]);
}
function apply(t,rows,allIds){
  for(const row of rows){const k=t+':'+row.id,m=cloud.meta[k],local=findLocal(t,row.id),remote=fromRow(t,row);
    const info={own:canWrite(t,row),mine:t==='clients'?row.user_id===cloud.user.id:undefined,user:row.user_id||null};
    if(m&&m.v===row.version&&local){Object.assign(m,info);continue} // nothing new
    const ours=local&&m&&!same(core(t,local),m.base); // changes here that haven't gone up yet
    putLocal(t,ours?merge3(m.base,core(t,local),remote):remote);
    cloud.meta[k]={v:row.version,base:remote,...info};
  }
  // gone from the server: gone here too (anything new here that hasn't been sent yet stays)
  const ids=new Set(allIds);
  for(const k of Object.keys(cloud.meta))if(k.startsWith(t+':')&&!ids.has(k.slice(t.length+1)))dropLocal(t,k.slice(t.length+1));
}
// send ours first, then fetch theirs, then redraw if anything changed
async function cloudSync(){
  if(!cloud.on)return;
  try{await cloudPush();if(await cloudPull()){fixUser();cloudRender()}}
  catch(e){cloud.state=isOffline(e)?'offline':'error';console.warn('Gymnazo sync:',e&&e.message||e)}
}
// redraw without throwing away what someone is typing
function cloudRender(){
  if(ui.welcome||ui.crop)return;
  const a=document.activeElement,id=a&&a.id,val=a&&a.value,pos=a&&a.selectionStart;
  render();
  if(id){const b=document.getElementById(id);if(b&&b!==a){if(val!=null&&'value' in b)b.value=val;b.focus();try{b.setSelectionRange(pos,pos)}catch(e){}}}
}
function cloudSoon(){clearTimeout(cloud.pullT);cloud.pullT=setTimeout(cloudSync,500)}

/* ---------- which side to open ---------- */
const myCoachRec=()=>S.coaches.find(co=>(cloud.meta['coaches:'+co.id]||{own:true}).own);
const myClientRec=()=>S.clients.find(c=>{const m=cloud.meta['clients:'+c.id];return m?m.mine:c.status!=='invited'&&!S.coaches.some(co=>co.id===c.coachId&&(cloud.meta['coaches:'+co.id]||{own:true}).own)});
function fixUser(){
  const u=ui.user,ok=u&&(u.role==='coach'?coach(u.id)&&(cloud.meta['coaches:'+u.id]||{own:true}).own:client(u.id)&&client(u.id)===myClientRec());
  if(ok)return;
  let last='';try{last=localStorage.getItem('gymnazo-mode')||''}catch(e){}
  const co=myCoachRec(),me=myClientRec();
  if(co&&(last==='coach'||!me))switchUser('coach',co.id);else if(me)switchUser('client',me.id);
}

/* ---------- accounts ---------- */
function cloudStart(){
  S=emptyS();
  const recovering=/type=recovery/.test(String(location.hash||''));
  const cached=cloudReadLocal();
  if(cached){cloud.on=true;ui.user=cached.user||ui.user;fixUser();if(!myCoachRec()&&!myClientRec())ui.welcome=wlNew('path')}
  else ui.welcome=wlNew('hello');
  cloud.db=supabase.createClient(CLOUD.url,CLOUD.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'implicit'}});
  cloud.db.auth.onAuthStateChange((ev,session)=>{
    // they tapped the reset link in their email: ask for the new password
    if(ev==='PASSWORD_RECOVERY'){ui.welcome=wlNew('newpw');setTimeout(render,0)}
  });
  cloud.db.auth.getSession().then(({data})=>{
    const s=data&&data.session;
    if(recovering&&s){ui.welcome=wlNew('newpw');render();return}
    if(!s){if(cloud.on){cloudForget();S=emptyS();ui.welcome=wlNew('hello');render()}return}
    if(cloud.user&&cloud.user.id!==s.user.id){cloudForget();S=emptyS()}
    cloudSignedIn(s.user);
  }).catch(()=>{}); // offline with a saved copy: carry on with that
  // live updates: a message or a finished workout shows up without refreshing
  try{cloud.db.channel('gymnazo').on('postgres_changes',{event:'*',schema:'public',table:'clients'},cloudSoon)
    .on('postgres_changes',{event:'*',schema:'public',table:'coaches'},cloudSoon)
    .on('postgres_changes',{event:'*',schema:'public',table:'templates'},cloudSoon).subscribe()}catch(e){}
  addEventListener('online',()=>cloudSync());
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')cloudSync();else if(cloud.on)cloudPush()});
}
// signed in: bring everything down, then open the app (or finish the welcome for a brand new account)
async function cloudSignedIn(user){
  cloud.user={id:user.id,email:user.email};cloud.on=true;
  try{await cloudPush();await cloudPull()}
  catch(e){if(!S.coaches.length&&!S.clients.length){toast(isOffline(e)?"No connection. Check your signal and try again.":"Couldn't load your account. Try again in a moment.");cloud.on=false;ui.welcome=wlNew('login');render();return}}
  if(!myCoachRec()&&!myClientRec()){
    // a brand new account (or one that confirmed their email): pick up the welcome where they left it
    let w=null;try{w=JSON.parse(localStorage.getItem('gymnazo-welcome'))}catch(e){}
    if(w&&w.path&&w.name){ui.welcome={...wlNew('done'),...w,step:'done'};render();return}
    if(!ui.welcome||['hello','login','check','newpw'].includes(ui.welcome.step))ui.welcome=wlNew('path');
    render();return;
  }
  if(ui.welcome&&ui.welcome.step!=='newpw')ui.welcome=null;
  fixUser();cloudSaveLocal();render();
}
const wlNew=step=>({step,path:null,code:'',name:'',theme:typeof themeOf==='function'&&ui.user?themeOf():'lime',email:'',pw:''});

// friendly words for what Supabase sends back when something goes wrong
function authMsg(e){const m=String(e&&e.message||e||'').toLowerCase();
  if(isOffline(e))return "No connection. Check your signal and try again.";
  if(/already registered|already exists/.test(m))return "There's already an account with that email. Log in instead.";
  if(/invalid login|invalid credentials/.test(m))return "That email and password don't match.";
  if(/not confirmed/.test(m))return "Confirm your email first. The link is in your inbox.";
  if(/rate limit|too many|429/.test(m))return "Too many tries. Wait a minute, then try again.";
  if(/password/.test(m)&&/(short|least|weak)/.test(m))return "Use a longer password, at least 8 characters.";
  if(/email/.test(m)&&/invalid/.test(m))return "That email doesn't look right.";
  return "Something went wrong. Try again.";
}
const okEmail=s=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());

async function cloudSignUp(email,pw,name){
  const {data,error}=await cloud.db.auth.signUp({email:email.trim(),password:pw,options:{emailRedirectTo:appUrl(),data:{name}}});
  if(error)throw error;
  if(data.session){cloud.user={id:data.user.id,email:data.user.email};cloud.on=true;return 'in'}
  return 'confirm'; // email confirmation is switched on: they need to tap the link first
}
async function cloudSignIn(email,pw){
  const {data,error}=await cloud.db.auth.signInWithPassword({email:email.trim(),password:pw});
  if(error)throw error;
  return data.user;
}
async function cloudSendReset(email){
  const {error}=await cloud.db.auth.resetPasswordForEmail(email.trim(),{redirectTo:appUrl()});
  if(error)throw error;
}
async function cloudNewPassword(pw){
  const {data,error}=await cloud.db.auth.updateUser({password:pw});
  if(error)throw error;
  try{history.replaceState(null,'',appUrl())}catch(e){}
  return data.user;
}
async function cloudSignOut(){
  try{await Promise.race([cloudPush(),new Promise(r=>setTimeout(r,4000))])}catch(e){} // last chance to send unsaved changes
  try{await cloud.db.auth.signOut()}catch(e){}
  cloudForget();S=emptyS();
}
// invite codes
async function cloudInviteInfo(code){const {data,error}=await cloud.db.rpc('invite_info',{p_code:code});if(error)throw error;return data}
async function cloudJoin(code,myId){
  await cloudPush(); // send anything waiting first, so the join starts from the latest
  const {data,error}=await cloud.db.rpc('join_with_code',{p_code:code,p_my_id:myId||null});
  if(error)throw error;
  if(data&&data.ok)await cloudPull();
  return data;
}
