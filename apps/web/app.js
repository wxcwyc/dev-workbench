import { buildOnboardingInput, formatApiError, parseSessionImport, safePreviewUrl, summarizeOnboarding } from "./onboarding.js";
import { addCommandArgument, addPlanStep, createPlanDraft, movePlanStep, removeCommandArgument, removePlanStep, toPlanInput, updateCommandArgument, updatePlanStep, validatePlanDraft } from "./plan-editor.js";

const state={sessions:[],sessionsRequest:0,openSessionRequest:0,active:null,events:null,onboarding:{inspection:null,draft:null,recent:[],allowedRoot:"",inspectRequest:0,importRequest:0,recentRequest:0,creationRequest:0,dialogGeneration:0,creating:false},planEditor:{draft:null,sessionId:null,dialogGeneration:0,saveRequest:0,saving:false,issues:[]}};
const $=(selector)=>document.querySelector(selector);

async function api(path,options={}){
  const response=await fetch(path,{headers:{"content-type":"application/json",...(options.headers??{})},...options});
  const body=await response.json();
  if(!response.ok)throw new Error(formatApiError(body));
  return body;
}

function escapeHtml(value){return String(value??"").replace(/[&<>'"]/g,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[character]);}
function stringValues(value){return Array.isArray(value)?value.filter((item)=>typeof item==="string"):[];}
function setOnboardingStatus(message,kind=""){
  const status=$("#onboarding-status");
  status.textContent=message;
  status.className=`onboarding-status${kind?` ${kind}`:""}`;
}

function clearOnboardingPreview(){
  state.onboarding.draft=null;
  $("#onboarding-create").disabled=true;
  $("#onboarding-preview").innerHTML=`<p class="muted">Inspect a project and preview the normalized session before creation.</p>`;
}

function invalidateOnboardingPreview(){
  clearOnboardingPreview();
  if(state.onboarding.inspection)setOnboardingStatus("Draft changed. Preview the safety gate again before creating.","warning");
}

function renderRecentProjects(){
  const container=$("#onboarding-recent");
  const recent=Array.isArray(state.onboarding.recent)?state.onboarding.recent:[];
  if(!recent.length){container.innerHTML=`<span class="muted">No recent projects yet.</span>`;return;}
  container.innerHTML=recent.map((entry,index)=>{
    const root=typeof entry?.projectRoot==="string"?entry.projectRoot:"Unknown path";
    const workbench=typeof entry?.workbench==="string"?entry.workbench:"unknown";
    return `<button type="button" class="recent-project" data-index="${index}" ${state.onboarding.creating?"disabled":""}><span>${escapeHtml(root)}</span><small>${escapeHtml(workbench)}</small></button>`;
  }).join("");
  container.querySelectorAll(".recent-project").forEach((button)=>{
    button.onclick=()=>{
      const entry=recent[Number(button.dataset.index)];
      if(typeof entry?.projectRoot!=="string")return;
      $("#project-path").value=entry.projectRoot;
      inspectOnboardingProject(entry.projectRoot);
    };
  });
}

async function refreshRecentProjects(reportError=true){
  const generation=state.onboarding.dialogGeneration;
  const request=++state.onboarding.recentRequest;
  const container=$("#onboarding-recent");
  container.innerHTML=`<span class="muted">Loading recent projects…</span>`;
  try{
    const recent=await api("/api/projects/recent");
    if(generation!==state.onboarding.dialogGeneration||request!==state.onboarding.recentRequest)return;
    state.onboarding.recent=Array.isArray(recent)?recent:[];
    renderRecentProjects();
  }catch(error){
    if(generation!==state.onboarding.dialogGeneration||request!==state.onboarding.recentRequest)return;
    state.onboarding.recent=[];
    container.innerHTML=`<span class="inline-error">${escapeHtml(error.message)}</span>`;
    if(reportError&&!state.onboarding.creating&&$("#project-onboarding").open)setOnboardingStatus(`Could not load recent projects: ${error.message}`,"error");
  }
}

function resetOnboarding(){
  state.onboarding.inspectRequest+=1;
  state.onboarding.importRequest+=1;
  state.onboarding.inspection=null;
  state.onboarding.draft=null;
  $("#project-inspect-form").reset();
  $("#onboarding-session-title").value="";
  $("#onboarding-import").value="";
  $("#onboarding-file").value="";
  document.querySelector('input[name="onboarding-workbench"][value="execution"]').checked=true;
  $("#onboarding-config").disabled=true;
  $("#onboarding-preview-action").disabled=true;
  $("#onboarding-detection").classList.add("hidden");
  $("#detection-facts").replaceChildren();
  $("#detection-evidence").replaceChildren();
  $("#detection-warnings").replaceChildren();
  clearOnboardingPreview();
  setOnboardingCreating(state.onboarding.creating);
  setOnboardingStatus(state.onboarding.creating?"Session creation is still in progress. You may close this dialog safely.":"Waiting for project inspection.",state.onboarding.creating?"loading":"");
  renderRecentProjects();
}

function openOnboarding(){
  resetOnboarding();
  $("#project-onboarding").showModal();
  refreshRecentProjects();
  $(state.onboarding.creating?"#onboarding-close":"#project-path").focus();
}

function renderInspection(inspection){
  const languages=stringValues(inspection?.languages);
  const frameworks=stringValues(inspection?.frameworks);
  const evidence=stringValues(inspection?.evidence);
  const warnings=stringValues(inspection?.warnings);
  const facts=[
    ["Git",inspection?.git===true?"repository":"not detected"],
    ["Package",typeof inspection?.packageManager==="string"?inspection.packageManager:"not detected"],
    ["Languages",languages.join(", ")||"not detected"],
    ["Frameworks",frameworks.join(", ")||"not detected"],
  ];
  $("#detection-facts").innerHTML=facts.map(([label,value])=>`<span class="detection-chip"><small>${label}</small>${escapeHtml(value)}</span>`).join("");
  $("#detection-evidence").innerHTML=evidence.length?`<strong>Evidence</strong><div>${evidence.map((item)=>`<code>${escapeHtml(item)}</code>`).join("")}</div>`:`<span class="muted">No manifest evidence detected.</span>`;
  $("#detection-warnings").innerHTML=warnings.length?`<strong>Inspection warnings</strong><ul>${warnings.map((warning)=>`<li>${escapeHtml(warning)}</li>`).join("")}</ul>`:"";
  $("#onboarding-detection").classList.remove("hidden");
}

function defaultSessionTitle(projectRoot){
  return String(projectRoot??"").split(/[\\/]/).filter(Boolean).at(-1)||"Local project";
}

async function inspectOnboardingProject(projectRoot){
  const candidate=typeof projectRoot==="string"?projectRoot.trim():"";
  if(!candidate){setOnboardingStatus("Enter a local project path to inspect.","error");return;}
  const request=++state.onboarding.inspectRequest;
  state.onboarding.inspection=null;
  $("#onboarding-config").disabled=true;
  $("#onboarding-preview-action").disabled=true;
  $("#onboarding-detection").classList.add("hidden");
  clearOnboardingPreview();
  $("#onboarding-inspect").disabled=true;
  setOnboardingStatus("Inspecting project boundary…","loading");
  try{
    const inspection=await api("/api/projects/inspect",{method:"POST",body:JSON.stringify({projectRoot:candidate})});
    if(request!==state.onboarding.inspectRequest)return;
    state.onboarding.inspection=inspection;
    renderInspection(inspection);
    $("#onboarding-session-title").value=defaultSessionTitle(inspection.projectRoot);
    $("#onboarding-config").disabled=false;
    $("#onboarding-preview-action").disabled=false;
    setOnboardingStatus("Inspection complete. Configure the session, then review the safety gate.","success");
  }catch(error){
    if(request!==state.onboarding.inspectRequest)return;
    setOnboardingStatus(error.message,"error");
  }finally{
    if(request===state.onboarding.inspectRequest)$("#onboarding-inspect").disabled=false;
  }
}

function selectedOnboardingWorkbench(){
  return document.querySelector('input[name="onboarding-workbench"]:checked')?.value;
}

function setOnboardingCreating(creating){
  state.onboarding.creating=creating;
  $("#project-path").disabled=creating;
  $("#onboarding-inspect").disabled=creating;
  $("#onboarding-config").disabled=creating||!state.onboarding.inspection;
  $("#onboarding-preview-action").disabled=creating||!state.onboarding.inspection;
  $("#onboarding-create").disabled=creating||!state.onboarding.draft;
  $("#onboarding-recent").querySelectorAll("button").forEach((button)=>{button.disabled=creating;});
}

function renderOnboardingPreview(input){
  const summary=summarizeOnboarding(input);
  const rows=summary.steps.map((step,index)=>`<div class="plan-row"><div class="plan-index">${String(index+1).padStart(2,"0")}</div><div class="plan-detail"><strong>${escapeHtml(step.title)}</strong><code>${escapeHtml(step.command||"No command — observation only")}</code><small>cwd: ${escapeHtml(step.cwd)}</small></div><span class="impact impact-${step.impact==="project-changing"?"change":"observe"}">${escapeHtml(step.impact)}</span></div>`).join("")||`<div class="plan-empty">No plan steps imported. This session starts empty.</div>`;
  $("#onboarding-preview").innerHTML=`<div class="safety-gate"><div><span class="gate-status">BOUNDARY VERIFIED</span><strong>Creation is inert</strong></div><p>Creating this session executes no commands.</p></div><dl class="normalized-session"><div><dt>Title</dt><dd>${escapeHtml(input.title)}</dd></div><div><dt>Workbench</dt><dd>${escapeHtml(input.workbench)}</dd></div><div><dt>Project root</dt><dd>${escapeHtml(input.projectRoot)}</dd></div><div><dt>Allowed root</dt><dd>${escapeHtml(state.onboarding.allowedRoot||"Unavailable")}</dd></div></dl><div class="plan-heading"><strong>Command &amp; observation manifest</strong><span>${summary.steps.length} item${summary.steps.length===1?"":"s"}</span></div><div class="plan-list">${rows}</div>`;
}

function previewOnboarding(){
  clearOnboardingPreview();
  try{
    const imported=parseSessionImport($("#onboarding-import").value);
    const input=buildOnboardingInput({
      inspection:state.onboarding.inspection,
      workbench:selectedOnboardingWorkbench(),
      title:$("#onboarding-session-title").value,
      imported,
    });
    state.onboarding.draft=input;
    renderOnboardingPreview(input);
    $("#onboarding-create").disabled=false;
    setOnboardingStatus("Safety gate reviewed. Session creation is unlocked.","success");
  }catch(error){
    setOnboardingStatus(error.message,"error");
  }
}

async function createOnboardingSession(){
  if(state.onboarding.creating)return;
  const draft=state.onboarding.draft;
  if(!draft)return;
  const generation=state.onboarding.dialogGeneration;
  const request=++state.onboarding.creationRequest;
  state.onboarding.recentRequest+=1;
  setOnboardingCreating(true);
  setOnboardingStatus("Creating session without executing commands…","loading");
  let session;
  let creationError;
  try{
    session=await api("/api/sessions",{method:"POST",body:JSON.stringify(draft)});
  }catch(error){
    creationError=error;
  }finally{
    if(request===state.onboarding.creationRequest)state.onboarding.creating=false;
    if(generation!==state.onboarding.dialogGeneration&&request===state.onboarding.creationRequest)setOnboardingCreating(false);
  }
  if(generation!==state.onboarding.dialogGeneration){
    if($("#project-onboarding").open)setOnboardingStatus(creationError?`Session creation failed: ${creationError.message}`:"Session created. You can inspect another project.",creationError?"error":"success");
    await Promise.allSettled([refreshSessions(),refreshRecentProjects(false)]);
    return;
  }
  if(creationError){
    setOnboardingCreating(state.onboarding.creating);
    setOnboardingStatus(creationError.message,"error");
    refreshRecentProjects(false);
    return;
  }
  await Promise.allSettled([refreshSessions(),refreshRecentProjects(false)]);
  if(generation!==state.onboarding.dialogGeneration||request!==state.onboarding.creationRequest){
    if(request===state.onboarding.creationRequest)setOnboardingCreating(state.onboarding.creating);
    return;
  }
  $("#project-onboarding").close();
  try{await openSession(session.id);}catch(error){$("#health").textContent=`session created; open failed: ${error.message}`;}
}
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
  $("#migration-view").innerHTML=`<div class="migration-grid"><section class="panel steps-panel"><div class="panel-title">Migration plan</div><div class="panel-body">${session.steps.map((step,index)=>`<div class="step ${step.status} ${index===session.cursor?"current":""}"><strong>${index+1}. ${escapeHtml(step.title)}</strong><small>${escapeHtml(step.description)}</small><small>${step.action?escapeHtml(step.action.command.join(" ")):"Observation step"}</small></div>`).join("")}</div></section><section class="panel"><div class="panel-title">${escapeHtml(session.metadata.sourceLabel??"Source")}</div><iframe class="preview" sandbox="allow-scripts allow-forms" src="${escapeHtml(safePreviewUrl(session.metadata.sourceUrl))}"></iframe></section><section class="panel"><div class="panel-title">${escapeHtml(session.metadata.targetLabel??"Target")}</div><iframe class="preview" sandbox="allow-scripts allow-forms" src="${escapeHtml(safePreviewUrl(session.metadata.targetUrl))}"></iframe></section><section class="panel"><div class="panel-title">Files & changes</div><div class="panel-body tree">${renderTree(snapshot)}</div></section><section class="panel"><div class="panel-title">Git diff</div><div class="panel-body"><pre>${escapeHtml(snapshot?.git?.diff||snapshot?.git?.status||"No Git diff at this checkpoint.")}</pre></div></section><section class="panel" style="grid-column:2/4"><div class="panel-title">Command output</div><div class="panel-body terminal"><pre>${command?`$ ${escapeHtml(command.command.join(" "))}\n${escapeHtml(command.stdout)}${escapeHtml(command.stderr)}`:"No command executed at this checkpoint."}</pre></div></section></div>`;
}

function isPristineMigration(session){
  return session?.workbench==="migration"&&session.cursor===-1&&session.steps.every((step)=>step.status==="pending")&&session.snapshots.length===0&&session.annotations.length===0;
}

function canEditPlan(session){return isPristineMigration(session);}
function planIssue(path){return state.planEditor.issues.find((issue)=>issue.path===path)?.message??"";}
function inlinePlanError(path){return `<span class="inline-error" data-error-path="${path}">${escapeHtml(planIssue(path))}</span>`;}

function syncPlanEditorValidation({preserveStatus=false}={}){
  const draft=state.planEditor.draft;
  if(!draft)return;
  const status=$("#plan-editor-status");
  const previousStatus=status.textContent;
  const previousClass=status.className;
  state.planEditor.issues=validatePlanDraft(draft);
  $("#plan-editor-steps").querySelectorAll("[data-error-path]").forEach((element)=>{element.textContent=planIssue(element.dataset.errorPath);});
  $("#plan-editor-save").disabled=state.planEditor.saving||state.planEditor.issues.length>0;
  if(preserveStatus){status.textContent=previousStatus;status.className=previousClass;}
  else if(state.planEditor.saving){status.textContent="Saving plan without executing commands…";status.className="loading";}
  else if(state.planEditor.issues.length){status.textContent=`Fix ${state.planEditor.issues[0].path}: ${state.planEditor.issues[0].message}`;status.className="error";}
  else{status.textContent="Ready to save. No commands will be executed.";status.className="";}
}

function renderPlanEditor({preserveStatus=false}={}){
  const draft=state.planEditor.draft;
  if(!draft)return;
  state.planEditor.issues=validatePlanDraft(draft);
  const locked=state.planEditor.saving;
  const last=draft.steps.length-1;
  $("#plan-editor-steps").innerHTML=draft.steps.map((step,index)=>{
    const title=step.title.trim()||`Untitled step ${index+1}`;
    const argv=step.command.map((argument,argumentIndex)=>`<div class="plan-argv-row"><input type="text" data-field="argument" data-step-index="${index}" data-argument-index="${argumentIndex}" value="${escapeHtml(argument)}" aria-label="Argument ${argumentIndex+1}" ${locked||!step.actionEnabled?"disabled":""}><button type="button" class="plan-remove" data-action="remove-argument" data-step-index="${index}" data-argument-index="${argumentIndex}" aria-label="Remove argument ${argumentIndex+1}" ${locked||!step.actionEnabled?"disabled":""}>Remove</button>${inlinePlanError(`/steps/${index}/action/command/${argumentIndex}`)}</div>`).join("");
    return `<details class="plan-step" open><summary><span class="plan-step-index">${String(index+1).padStart(2,"0")}</span><span class="plan-step-title">${escapeHtml(title)}</span></summary><div class="plan-step-content"><div class="plan-step-actions"><button type="button" data-action="move-up" data-step-index="${index}" aria-label="Move step ${index+1} up" ${locked||index===0?"disabled":""}>↑</button><button type="button" data-action="move-down" data-step-index="${index}" aria-label="Move step ${index+1} down" ${locked||index===last?"disabled":""}>↓</button><button type="button" class="plan-remove" data-action="remove-step" data-step-index="${index}" ${locked?"disabled":""}>Delete</button></div><div class="plan-field-grid"><label>Title<input type="text" data-field="title" data-step-index="${index}" value="${escapeHtml(step.title)}" ${locked?"disabled":""}>${inlinePlanError(`/steps/${index}/title`)}</label><label>Description<textarea data-field="description" data-step-index="${index}" ${locked?"disabled":""}>${escapeHtml(step.description)}</textarea>${inlinePlanError(`/steps/${index}/description`)}</label><label>Expected result<textarea data-field="expected" data-step-index="${index}" ${locked?"disabled":""}>${escapeHtml(step.expected)}</textarea>${inlinePlanError(`/steps/${index}/expected`)}</label></div><label class="plan-action-toggle"><input type="checkbox" data-field="actionEnabled" data-step-index="${index}" ${step.actionEnabled?"checked":""} ${locked?"disabled":""}> Run a command for this step</label><div class="plan-action-fields" ${step.actionEnabled?"":`aria-disabled="true"`}><div class="plan-argv-list">${argv||`<span class="muted">No arguments yet.</span>`}</div>${inlinePlanError(`/steps/${index}/action/command`)}<button type="button" data-action="add-argument" data-step-index="${index}" ${locked||!step.actionEnabled?"disabled":""}>+ Add argument</button><label>Working directory<input type="text" data-field="cwd" data-step-index="${index}" value="${escapeHtml(step.cwd)}" ${locked||!step.actionEnabled?"disabled":""}>${inlinePlanError(`/steps/${index}/action/cwd`)}</label></div></div></details>`;
  }).join("")||`<div class="plan-empty">No plan steps. Add one or save an empty plan.</div>`;
  $("#plan-editor-add").disabled=locked;
  $("#plan-editor-cancel").disabled=false;
  syncPlanEditorValidation({preserveStatus});
}

function invalidatePlanEditor(){
  state.planEditor.dialogGeneration+=1;
  state.planEditor.draft=null;
  state.planEditor.sessionId=null;
  state.planEditor.issues=[];
}

function closePlanEditor(){
  const dialog=$("#plan-editor");
  invalidatePlanEditor();
  if(dialog.open)dialog.close();
}

function openPlanEditor(){
  const session=state.active;
  if(!isPristineMigration(session))return;
  state.planEditor.dialogGeneration+=1;
  state.planEditor.sessionId=session.id;
  state.planEditor.draft=createPlanDraft(session);
  state.planEditor.issues=[];
  renderPlanEditor();
  $("#plan-editor").showModal();
  $(state.planEditor.saving?"#plan-editor-cancel":"#plan-editor-add").focus();
}

async function savePlan(){
  if(state.planEditor.saving||!state.planEditor.draft||!state.planEditor.sessionId)return;
  state.planEditor.issues=validatePlanDraft(state.planEditor.draft);
  if(state.planEditor.issues.length){renderPlanEditor();return;}
  const generation=state.planEditor.dialogGeneration;
  const sessionId=state.planEditor.sessionId;
  const request=++state.planEditor.saveRequest;
  const input=toPlanInput(state.planEditor.draft);
  state.planEditor.saving=true;
  renderPlanEditor();
  let session;
  let saveError;
  try{session=await api(`/api/sessions/${sessionId}/plan`,{method:"PUT",body:JSON.stringify(input)});}
  catch(error){saveError=error;}
  if(request===state.planEditor.saveRequest)state.planEditor.saving=false;
  const owns=$("#plan-editor").open&&generation===state.planEditor.dialogGeneration&&sessionId===state.planEditor.sessionId&&state.active?.id===sessionId;
  if(!owns){if(request===state.planEditor.saveRequest&&state.planEditor.draft&&$("#plan-editor").open)renderPlanEditor({preserveStatus:true});return;}
  if(saveError){renderPlanEditor();$("#plan-editor-status").textContent=saveError.message;$("#plan-editor-status").className="error";return;}
  renderSession(session);
  closePlanEditor();
  refreshSessions().catch((error)=>{$("#health").textContent=`session list refresh failed: ${error.message}`;});
}

function renderSession(session){
  if(state.planEditor.sessionId&&(state.planEditor.sessionId!==session.id||!isPristineMigration(session)))closePlanEditor();
  state.active=session;
  $("#empty").classList.add("hidden");$("#workbench").classList.remove("hidden");
  $("#session-title").textContent=session.title;$("#session-path").textContent=session.projectRoot;
  $("#workbench-badge").textContent=session.workbench==="execution"?"EXECUTION EXPLORER":"MIGRATION CENTER";
  $("#session-status").textContent=session.status;
  $("#edit-plan").hidden=session.workbench!=="migration";
  $("#edit-plan").disabled=!canEditPlan(session);
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

async function refreshSessions(){
  const request=++state.sessionsRequest;
  const sessions=await api("/api/sessions");
  if(request!==state.sessionsRequest)return;
  state.sessions=sessions;
  renderSessions();
}
async function openSession(id){
  const request=++state.openSessionRequest;
  let session;
  try{
    session=await api(`/api/sessions/${id}`);
  }catch(error){
    if(request!==state.openSessionRequest)return;
    throw error;
  }
  if(request!==state.openSessionRequest)return;
  if(state.events){state.events.onmessage=null;state.events.close();}
  renderSession(session);
  const sessionEvents=new EventSource(`/api/sessions/${id}/events`);
  state.events=sessionEvents;
  sessionEvents.onmessage=(event)=>{if(state.events!==sessionEvents)return;const session=JSON.parse(event.data);if(state.active?.id===session.id)renderSession(session);};
}
async function seek(stepIndex){renderSession(await api(`/api/sessions/${state.active.id}/seek`,{method:"POST",body:JSON.stringify({stepIndex})}));}
async function createExample(name){const session=await api(`/api/examples/${name}`,{method:"POST",body:"{}"});await refreshSessions();await openSession(session.id);}

// Narrow test seam for exercising this module's browser controller behavior.
export const __testing=Object.freeze({
  state,
  canEditPlan,
  renderSession,
  renderPlanEditor,
  openPlanEditor,
  closePlanEditor,
  savePlan,
  openSession,
  openOnboarding,
  createOnboardingSession,
  renderInspection,
  renderOnboardingPreview,
});

$("#open-project").onclick=openOnboarding;
$("#open-project-mobile").onclick=openOnboarding;
$("#onboarding-close").onclick=()=>$("#project-onboarding").close();
$("#project-onboarding").onclose=()=>{state.onboarding.dialogGeneration+=1;};
$("#project-inspect-form").onsubmit=(event)=>{event.preventDefault();inspectOnboardingProject($("#project-path").value);};
$("#project-path").oninput=()=>{
  const hadActiveInspection=Boolean(state.onboarding.inspection)||$("#onboarding-inspect").disabled;
  state.onboarding.inspectRequest+=1;
  $("#onboarding-inspect").disabled=false;
  if(!hadActiveInspection)return;
  state.onboarding.inspection=null;
  $("#onboarding-config").disabled=true;
  $("#onboarding-preview-action").disabled=true;
  $("#onboarding-detection").classList.add("hidden");
  clearOnboardingPreview();
  setOnboardingStatus("Path changed. Inspect this boundary before continuing.","warning");
};
document.querySelectorAll('input[name="onboarding-workbench"]').forEach((input)=>input.onchange=invalidateOnboardingPreview);
$("#onboarding-session-title").oninput=invalidateOnboardingPreview;
$("#onboarding-import").oninput=()=>{
  state.onboarding.importRequest+=1;
  $("#onboarding-preview-action").disabled=!state.onboarding.inspection;
  invalidateOnboardingPreview();
};
$("#onboarding-file").onchange=async(event)=>{
  const file=event.target.files?.[0];
  if(!file)return;
  const request=++state.onboarding.importRequest;
  invalidateOnboardingPreview();
  $("#onboarding-preview-action").disabled=true;
  setOnboardingStatus(`Reading ${file.name}…`,"loading");
  try{
    const text=await file.text();
    if(request!==state.onboarding.importRequest)return;
    $("#onboarding-import").value=text;
    invalidateOnboardingPreview();
    $("#onboarding-preview-action").disabled=!state.onboarding.inspection;
    setOnboardingStatus(`Loaded ${file.name}. Preview the safety gate to validate it.`,"success");
  }catch(error){
    if(request!==state.onboarding.importRequest)return;
    $("#onboarding-preview-action").disabled=!state.onboarding.inspection;
    setOnboardingStatus(`Could not read JSON file: ${error.message}`,"error");
  }finally{
    if(event.target.files?.[0]===file)event.target.value="";
  }
};
$("#onboarding-preview-action").onclick=previewOnboarding;
$("#onboarding-create").onclick=createOnboardingSession;

$("#edit-plan").onclick=openPlanEditor;
$("#plan-editor").onclose=()=>{if(!$("#plan-editor").open&&state.planEditor.sessionId!==null)invalidatePlanEditor();};
$("#plan-editor-cancel").onclick=closePlanEditor;
$("#plan-editor-save").onclick=savePlan;
$("#plan-editor-add").onclick=()=>{if(state.planEditor.saving||!state.planEditor.draft)return;state.planEditor.draft=addPlanStep(state.planEditor.draft);renderPlanEditor();};
$("#plan-editor-steps").oninput=(event)=>{
  const target=event.target.closest("[data-field]");
  if(!target||state.planEditor.saving||!state.planEditor.draft)return;
  const stepIndex=Number(target.dataset.stepIndex);
  if(target.dataset.field==="argument")state.planEditor.draft=updateCommandArgument(state.planEditor.draft,stepIndex,Number(target.dataset.argumentIndex),target.value);
  else state.planEditor.draft=updatePlanStep(state.planEditor.draft,stepIndex,{[target.dataset.field]:target.dataset.field==="actionEnabled"?target.checked:target.value});
  const card=target.closest(".plan-step");
  if(target.dataset.field==="title"){
    const title=state.planEditor.draft.steps[stepIndex].title.trim()||`Untitled step ${stepIndex+1}`;
    const summary=card?.querySelector(".plan-step-title");
    if(summary)summary.textContent=title;
  }
  if(target.dataset.field==="actionEnabled"){
    const enabled=target.checked;
    const actionFields=card?.querySelector(".plan-action-fields");
    if(enabled)actionFields?.removeAttribute("aria-disabled");else actionFields?.setAttribute("aria-disabled","true");
    card?.querySelectorAll('[data-action="add-argument"], [data-action="remove-argument"], [data-field="argument"], [data-field="cwd"]').forEach((control)=>{control.disabled=!enabled;});
  }
  syncPlanEditorValidation();
};
$("#plan-editor-steps").onclick=(event)=>{
  const target=event.target.closest("[data-action]");
  if(!target||state.planEditor.saving||!state.planEditor.draft)return;
  const stepIndex=Number(target.dataset.stepIndex);
  if(target.dataset.action==="move-up")state.planEditor.draft=movePlanStep(state.planEditor.draft,stepIndex,-1);
  else if(target.dataset.action==="move-down")state.planEditor.draft=movePlanStep(state.planEditor.draft,stepIndex,1);
  else if(target.dataset.action==="remove-step")state.planEditor.draft=removePlanStep(state.planEditor.draft,stepIndex);
  else if(target.dataset.action==="add-argument")state.planEditor.draft=addCommandArgument(state.planEditor.draft,stepIndex);
  else if(target.dataset.action==="remove-argument")state.planEditor.draft=removeCommandArgument(state.planEditor.draft,stepIndex,Number(target.dataset.argumentIndex));
  renderPlanEditor();
};

$("#logic-demo").onclick=()=>createExample("logic-trace").catch((error)=>alert(error.message));
$("#migration-demo").onclick=()=>createExample("migration-demo").catch((error)=>alert(error.message));
$("#session-file").onchange=async(event)=>{try{const input=JSON.parse(await event.target.files[0].text());const session=await api("/api/sessions",{method:"POST",body:JSON.stringify(input)});await refreshSessions();await openSession(session.id);}catch(error){alert(error.message);}event.target.value="";};
$("#run-next").onclick=async()=>{const index=Number($("#run-next").dataset.index);const step=state.active.steps[index];if(step.action&&!confirm(`Run this command?\n\n${step.action.command.join(" ")}\n\nin ${state.active.projectRoot}`))return;try{renderSession(await api(`/api/sessions/${state.active.id}/steps/${index}/run`,{method:"POST",body:JSON.stringify({confirmed:true})}));await refreshSessions();}catch(error){alert(error.message);await openSession(state.active.id);}};
$("#previous").onclick=()=>seek(state.active.cursor-1);$("#next").onclick=()=>seek(state.active.cursor+1);$("#latest").onclick=()=>seek(Number($("#latest").dataset.index));
$("#note-form").onsubmit=async(event)=>{event.preventDefault();const text=$("#note-text").value.trim();if(!text)return;renderSession(await api(`/api/sessions/${state.active.id}/annotations`,{method:"POST",body:JSON.stringify({stepIndex:state.active.cursor,text})}));$("#note-text").value="";};

try{const health=await api("/api/health");state.onboarding.allowedRoot=typeof health.allowedRoot==="string"?health.allowedRoot:"";$("#health").textContent="● engine online";$("#allowed-root").textContent=state.onboarding.allowedRoot;await refreshSessions();}catch(error){$("#health").textContent=`offline: ${error.message}`;}
await refreshRecentProjects();
