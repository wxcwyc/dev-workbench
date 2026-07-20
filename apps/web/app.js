const state={sessions:[],active:null,events:null};
const $=(selector)=>document.querySelector(selector);

async function api(path,options={}){
  const response=await fetch(path,{headers:{"content-type":"application/json",...(options.headers??{})},...options});
  const body=await response.json();
  if(!response.ok)throw new Error(body.error??"Request failed");
  return body;
}

function escapeHtml(value){return String(value??"").replace(/[&<>'"]/g,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[character]);}
function currentTrace(session){return session.currentSnapshot?.trace??session.steps[session.cursor]?.traceState??null;}
function annotations(session){return session.annotations.filter((note)=>note.stepIndex===session.cursor);}

function renderSessions(){
  $("#sessions").innerHTML=state.sessions.map((session)=>`<button class="session-item ${state.active?.id===session.id?"active":""}" data-id="${session.id}">${escapeHtml(session.title)}<small>${session.workbench} · ${session.status}</small></button>`).join("")||`<span class="muted">No sessions yet.</span>`;
  document.querySelectorAll(".session-item").forEach((button)=>button.onclick=()=>openSession(button.dataset.id));
}

function renderTimeline(session){
  $("#timeline").innerHTML=session.steps.map((step,index)=>`<button title="${escapeHtml(step.traceKind?`${step.traceKind}: ${step.title}`:step.title)}" class="${step.status} trace-${escapeHtml(step.traceKind??"")} ${index===session.cursor?"current":""}" data-index="${index}" ${!session.snapshots[index]&&!step.traceState?"disabled":""}></button>`).join("");
  document.querySelectorAll("#timeline button:not(:disabled)").forEach((button)=>button.onclick=()=>seek(Number(button.dataset.index)));
  $("#step-counter").textContent=session.cursor<0?`Before start · ${session.steps.length} steps`:`Step ${session.cursor+1} of ${session.steps.length}`;
  $("#previous").disabled=session.cursor<=0;
  $("#next").disabled=session.cursor<0||session.cursor>=session.steps.length-1||(!session.snapshots[session.cursor+1]&&!session.steps[session.cursor+1]?.traceState);
  const lastRecorded=session.steps.reduce((last,step,index)=>(session.snapshots[index]||step.traceState)?index:last,-1);
  $("#latest").disabled=lastRecorded<0||lastRecorded===session.cursor;
  $("#latest").dataset.index=String(lastRecorded);
}

function renderExecution(session){
  const trace=currentTrace(session)??{};
  const step=session.steps[session.cursor];
  const program=trace.program??[];
  const unification=trace.unification?`<div class="goal"><strong>Unification ${trace.unification.succeeded?"succeeded":"failed"}</strong><div>${escapeHtml(trace.unification.goal)} ⇔ ${escapeHtml(trace.unification.head)}</div><div>Before: ${escapeHtml(JSON.stringify(trace.unification.before))}</div><div>After: ${escapeHtml(JSON.stringify(trace.unification.after))}</div></div>`:"";
  const choicePoint=trace.choicePoint?`<div class="goal"><strong>Choice point: ${escapeHtml(trace.choicePoint.goal)}</strong>${trace.choicePoint.candidates.map((candidate)=>`<div>Line ${candidate.line}: ${escapeHtml(candidate.rule)}</div>`).join("")}</div>`:"";
  const backtracking=trace.backtracking?`<div class="goal"><strong>Backtracking</strong><div>From: ${escapeHtml(trace.backtracking.fromRule)}</div><div>Reason: ${escapeHtml(trace.backtracking.reason)}</div></div>`:"";
  $("#execution-view").innerHTML=`${step?.traceKind?`<div class="trace-heading trace-${escapeHtml(step.traceKind)}"><strong>${escapeHtml(step.traceKind)}</strong> ${escapeHtml(step.title)}${step.description?` · ${escapeHtml(step.description)}`:""}</div>`:""}<div class="grid-two"><section class="panel"><div class="panel-title">Program</div><div class="panel-body">${program.map((line,index)=>`<div class="code-line ${trace.currentLine===index+1?"active":""}">${String(index+1).padStart(2,"0")} ${escapeHtml(line)}</div>`).join("")||`<span class="muted">No program state</span>`}</div></section><section class="panel"><div class="panel-title">Stack, goals & evidence</div><div class="panel-body">${(trace.stack??[]).map((frame,index)=>`<div class="goal"><strong>R${(trace.stack.length-index)} ${escapeHtml(frame.rule)}</strong><div>Goals: ${escapeHtml((frame.goals??[]).join(", ")||"✓ complete")}</div><div>Bindings: ${escapeHtml(JSON.stringify(frame.bindings??{}))}</div></div>`).join("")}<p>Current goals: <strong>${escapeHtml((trace.goals??[]).join(", ")||"none")}</strong></p><p>Query bindings: <strong>${escapeHtml(JSON.stringify(trace.bindings??{}))}</strong></p>${unification}${choicePoint}${backtracking}${trace.failureReason?`<div class="goal"><strong>Failure: ${escapeHtml(trace.failureReason)}</strong></div>`:""}${trace.result?`<div class="result">Result: ${escapeHtml(trace.result)}</div>`:""}</div></section></div>`;
}

function renderTree(snapshot){
  const changes=new Map((snapshot?.treeChanges??[]).map((change)=>[change.path,change.status]));
  return (snapshot?.tree?.entries??[]).map((entry)=>`<div class="${entry.type} change-${changes.get(entry.path)??""}">${entry.type==="directory"?"▸":"·"} ${escapeHtml(entry.path)} ${changes.has(entry.path)?`[${changes.get(entry.path)}]`:""}</div>`).join("")||`<span class="muted">Run a step to capture the file tree.</span>`;
}

function renderMigration(session){
  const snapshot=session.currentSnapshot;
  const command=snapshot?.command;
  $("#migration-view").innerHTML=`<div class="migration-grid"><section class="panel steps-panel"><div class="panel-title">Migration plan</div><div class="panel-body">${session.steps.map((step,index)=>`<div class="step ${step.status} ${index===session.cursor?"current":""}"><strong>${index+1}. ${escapeHtml(step.title)}</strong><small>${escapeHtml(step.description)}</small><small>${step.action?escapeHtml(step.action.command.join(" ")):"Observation step"}</small></div>`).join("")}</div></section><section class="panel"><div class="panel-title">${escapeHtml(session.metadata.sourceLabel??"Source")}</div><iframe class="preview" src="${escapeHtml(session.metadata.sourceUrl??"about:blank")}"></iframe></section><section class="panel"><div class="panel-title">${escapeHtml(session.metadata.targetLabel??"Target")}</div><iframe class="preview" src="${escapeHtml(session.metadata.targetUrl??"about:blank")}"></iframe></section><section class="panel"><div class="panel-title">Files & changes</div><div class="panel-body tree">${renderTree(snapshot)}</div></section><section class="panel"><div class="panel-title">Git diff</div><div class="panel-body"><pre>${escapeHtml(snapshot?.git?.diff||snapshot?.git?.status||"No Git diff at this checkpoint.")}</pre></div></section><section class="panel" style="grid-column:2/4"><div class="panel-title">Command output</div><div class="panel-body terminal"><pre>${command?`$ ${escapeHtml(command.command.join(" "))}\n${escapeHtml(command.stdout)}${escapeHtml(command.stderr)}`:"No command executed at this checkpoint."}</pre></div></section></div>`;
}

function renderSession(session){
  state.active=session;
  $("#empty").classList.add("hidden");$("#workbench").classList.remove("hidden");
  $("#session-title").textContent=session.title;$("#session-path").textContent=session.projectRoot;
  $("#workbench-badge").textContent=session.workbench==="execution"?"EXECUTION EXPLORER":"MIGRATION CENTER";
  $("#session-status").textContent=session.status;
  $("#execution-view").classList.toggle("hidden",session.workbench!=="execution");
  $("#migration-view").classList.toggle("hidden",session.workbench!=="migration");
  if(session.workbench==="execution")renderExecution(session);else renderMigration(session);
  const nextIndex=session.steps.findIndex((step)=>["pending","failed"].includes(step.status));
  $("#run-next").classList.toggle("hidden",session.workbench==="execution"&&nextIndex===-1);
  $("#run-next").disabled=nextIndex===-1||session.status==="running";
  $("#run-next").dataset.index=String(nextIndex);
  $("#run-next").textContent=nextIndex<0?"Plan completed":`Run step ${nextIndex+1}`;
  renderTimeline(session);
  $("#notes-title").textContent=session.cursor<0?"Notes":"Notes for step "+(session.cursor+1);
  $("#notes").innerHTML=annotations(session).map((note)=>`<div class="note">${escapeHtml(note.text)}<small> · ${new Date(note.createdAt).toLocaleString()}</small></div>`).join("")||`<span class="muted">No notes for this step.</span>`;
  $("#note-form").classList.toggle("hidden",session.cursor<0);
  renderSessions();
}

async function refreshSessions(){state.sessions=await api("/api/sessions");renderSessions();}
async function openSession(id){
  if(state.events)state.events.close();
  renderSession(await api(`/api/sessions/${id}`));
  state.events=new EventSource(`/api/sessions/${id}/events`);
  state.events.onmessage=(event)=>{const session=JSON.parse(event.data);if(state.active?.id===session.id)renderSession(session);};
}
async function seek(stepIndex){renderSession(await api(`/api/sessions/${state.active.id}/seek`,{method:"POST",body:JSON.stringify({stepIndex})}));}
async function createExample(name){const session=await api(`/api/examples/${name}`,{method:"POST",body:"{}"});await refreshSessions();await openSession(session.id);}

$("#logic-demo").onclick=()=>createExample("logic-trace").catch((error)=>alert(error.message));
$("#migration-demo").onclick=()=>createExample("migration-demo").catch((error)=>alert(error.message));
$("#session-file").onchange=async(event)=>{try{const input=JSON.parse(await event.target.files[0].text());const session=await api("/api/sessions",{method:"POST",body:JSON.stringify(input)});await refreshSessions();await openSession(session.id);}catch(error){alert(error.message);}event.target.value="";};
$("#run-next").onclick=async()=>{const index=Number($("#run-next").dataset.index);const step=state.active.steps[index];if(step.action&&!confirm(`Run this command?\n\n${step.action.command.join(" ")}\n\nin ${state.active.projectRoot}`))return;try{renderSession(await api(`/api/sessions/${state.active.id}/steps/${index}/run`,{method:"POST",body:JSON.stringify({confirmed:true})}));await refreshSessions();}catch(error){alert(error.message);await openSession(state.active.id);}};
$("#previous").onclick=()=>seek(state.active.cursor-1);$("#next").onclick=()=>seek(state.active.cursor+1);$("#latest").onclick=()=>seek(Number($("#latest").dataset.index));
$("#note-form").onsubmit=async(event)=>{event.preventDefault();const text=$("#note-text").value.trim();if(!text)return;renderSession(await api(`/api/sessions/${state.active.id}/annotations`,{method:"POST",body:JSON.stringify({stepIndex:state.active.cursor,text})}));$("#note-text").value="";};

try{const health=await api("/api/health");$("#health").textContent="● engine online";$("#allowed-root").textContent=health.allowedRoot;await refreshSessions();}catch(error){$("#health").textContent=`offline: ${error.message}`;}
