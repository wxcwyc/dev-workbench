import { buildOnboardingInput, formatApiError, parseSessionImport, safePreviewUrl, summarizeOnboarding } from "./onboarding.js";
import { addCommandArgument, addPlanStep, createPlanDraft, movePlanStep, removeCommandArgument, removePlanStep, toPlanInput, updateCommandArgument, updatePlanStep, validatePlanDraft } from "./plan-editor.js";

const state={sessions:[],sessionsRequest:0,openSessionRequest:0,active:null,activeGeneration:0,events:null,runtime:{sessionId:null,source:null,target:null,events:[],latestSequence:0,filter:"all",eventSource:null,requests:{source:0,target:0},pending:{source:false,target:false},refresh:{source:0,target:0}},sessionAction:{request:0,pending:false,sessionId:null},onboarding:{inspection:null,draft:null,recent:[],allowedRoot:"",inspectRequest:0,importRequest:0,recentRequest:0,creationRequest:0,dialogGeneration:0,creating:false},planEditor:{draft:null,sessionId:null,dialogGeneration:0,saveRequest:0,saving:false,stale:false,issues:[]},review:{selectedAttemptId:null,selectedPath:"",diff:null,diffRequest:0,diffLoading:false,diffError:"",diffMode:"unified",diffSearch:"",cancel:{request:0,pending:false,sessionId:null,stepIndex:-1,attempt:null,requested:false},restore:{target:null,request:0,pending:false,trigger:null}}};
const $=(selector)=>document.querySelector(selector);
const terminalClientLimit=256*1024;
const reviewRenderLineLimit=400;
const previewStates=new Set(["unconfigured","stopped","starting","running","conflict","exited","stopping"]);

async function api(path,options={}){
  const response=await fetch(path,{headers:{"content-type":"application/json",...(options.headers??{})},...options});
  const body=await response.json();
  if(!response.ok)throw new Error(formatApiError(body));
  return body;
}

function escapeHtml(value){return String(value??"").replace(/[&<>'"]/g,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[character]);}
function stringValues(value){return Array.isArray(value)?value.filter((item)=>typeof item==="string"):[];}
function stepRisk(step){return step?.risk??"low";}
function stepDependencies(step){return Array.isArray(step?.dependsOn)?step.dependsOn:[];}
function stepAttempt(step){return Number.isInteger(step?.attempt)?step.attempt:0;}
function dependenciesSatisfied(session,step){return stepDependencies(step).every((dependencyId)=>session.steps.some((candidate)=>candidate.id===dependencyId&&candidate.status==="completed"));}
function awaitingReviewIndex(session){return session?.workbench==="migration"?session.steps.findIndex((step)=>step.status==="awaiting_review"):-1;}
function isCandidateSessionNewer(current,candidate){
  const currentTime=Date.parse(current?.updatedAt??"");
  const candidateTime=Date.parse(candidate?.updatedAt??"");
  if(Number.isFinite(currentTime)&&Number.isFinite(candidateTime)&&candidateTime!==currentTime)return candidateTime>currentTime;
  const currentEvents=Array.isArray(current?.events)?current.events.length:null;
  const candidateEvents=Array.isArray(candidate?.events)?candidate.events.length:null;
  if(Number.isInteger(currentEvents)&&Number.isInteger(candidateEvents)&&candidateEvents!==currentEvents)return candidateEvents>currentEvents;
  return false;
}
function nextRunnableIndex(session){
  if(!session)return-1;
  if(session.workbench==="migration"){
    if(awaitingReviewIndex(session)!==-1||session.steps.some((step)=>step.status==="running"))return-1;
    return session.steps.findIndex((step)=>["pending","failed"].includes(step.status)&&dependenciesSatisfied(session,step));
  }
  return session.steps.findIndex((step)=>["pending","failed"].includes(step.status));
}
function runButtonLabel(session,index){
  if(index<0)return"Plan completed";
  return `${session.steps[index].status==="failed"?"Retry":"Run"} step ${index+1}`;
}
function confirmationMessage(session,step,index){
  const command=step.action?.command?.join(" ");
  if(stepRisk(step)==="high"){
    return `${step.status==="failed"?"Retry":"Run"} high-risk migration step?\n\nTarget: Step ${index+1} · ${step.title} [${step.id}]\nRisk: high${command?`\nCommand: ${command}\nProject root: ${session.projectRoot}`:"\nObservation only"}\n\nProceed?`;
  }
  if(command)return `Run this command?\n\n${command}\n\nin ${session.projectRoot}`;
  return `Run step ${index+1}?`;
}
function migrationAttempts(session){return Array.isArray(session?.attempts)?session.attempts:[];}
function filesForAttempt(attempt){return Array.isArray(attempt?.snapshot?.files)?attempt.snapshot.files:[];}
function hasRecordedBaseline(attempt){return typeof attempt?.baseline?.oid==="string"&&attempt.baseline.oid!==""&&typeof attempt?.baseline?.ref==="string"&&attempt.baseline.ref!=="";}
function hasRestorableResult(attempt){return attempt?.result?.restorable===true&&typeof attempt?.result?.oid==="string"&&attempt.result.oid!==""&&typeof attempt?.result?.ref==="string"&&attempt.result.ref!=="";}
function latestAttemptForStep(session,stepIndex){
  const step=session?.steps?.[stepIndex];
  if(!step)return null;
  const stepAttempts=migrationAttempts(session).filter((attempt)=>attempt.stepIndex===stepIndex);
  if(!stepAttempts.length)return null;
  return stepAttempts.find((attempt)=>attempt.attempt===stepAttempt(step))??stepAttempts.at(-1)??null;
}
function currentReviewAttempt(session){
  if(session?.workbench!=="migration")return null;
  if(Number.isInteger(session.cursor)&&session.cursor>=0){
    const current=latestAttemptForStep(session,session.cursor);
    if(current)return current;
  }
  const checkpointId=session.workspace?.currentCheckpointId;
  if(typeof checkpointId==="string"&&checkpointId&&checkpointId!=="initial"){
    return migrationAttempts(session).find((attempt)=>attempt.id===checkpointId)??null;
  }
  return migrationAttempts(session).at(-1)??null;
}
function reviewCheckpointTarget(session,checkpointId){
  if(session?.workbench!=="migration"||!session.workspace)return null;
  if(checkpointId==="initial"){
    const initialAttempt=migrationAttempts(session).find(hasRecordedBaseline);
    if(!initialAttempt)return null;
    const initial=initialAttempt.baseline;
    return {
      checkpointId:"initial",
      label:"Initial workspace base",
      oid:initial.oid,
      ref:initial.ref,
      executionRoot:session.workspace.executionRoot,
      stepIndex:-1,
    };
  }
  const attempt=migrationAttempts(session).find((candidate)=>candidate.id===checkpointId&&hasRestorableResult(candidate));
  if(!attempt)return null;
  return {
    checkpointId,
    label:`Accepted result · Step ${attempt.stepIndex+1} · Attempt ${attempt.attempt}`,
    oid:attempt.result.oid,
    ref:attempt.result.ref,
    executionRoot:session.workspace.executionRoot,
    stepIndex:attempt.stepIndex,
  };
}
function matchingRetryAttempt(session,stepIndex){
  const step=session?.steps?.[stepIndex];
  if(!step||!["failed","cancelled"].includes(step.status))return null;
  const attempt=latestAttemptForStep(session,stepIndex);
  return hasRecordedBaseline(attempt)?attempt:null;
}
function resetReviewDiff(){
  state.review.diff=null;
  state.review.diffLoading=false;
  state.review.diffError="";
}
function closeRestoreDialog({focusTrigger=true}={}){
  const dialog=$("#restore-checkpoint-dialog");
  const trigger=state.review.restore.trigger;
  state.review.restore.target=null;
  state.review.restore.pending=false;
  state.review.restore.trigger=null;
  if(dialog.open)dialog.close();
  if(focusTrigger&&trigger?.focus)trigger.focus();
}
function syncReviewSelection(session){
  const attempt=currentReviewAttempt(session);
  if(!attempt){
    state.review.selectedAttemptId=null;
    state.review.selectedPath="";
    resetReviewDiff();
    return null;
  }
  const files=filesForAttempt(attempt);
  const attemptChanged=state.review.selectedAttemptId!==attempt.id;
  if(attemptChanged){
    state.review.selectedAttemptId=attempt.id;
    state.review.selectedPath="";
    resetReviewDiff();
  }
  const hasSelection=files.some((entry)=>entry.path===state.review.selectedPath);
  if(!hasSelection){
    state.review.selectedPath=files[0]?.path??"";
    resetReviewDiff();
  }
  return attempt;
}
function syncCancelState(session){
  const cancel=state.review.cancel;
  if(cancel.sessionId!==session?.id){
    state.review.cancel={request:cancel.request,pending:false,sessionId:null,stepIndex:-1,attempt:null,requested:false};
    return;
  }
  const step=session?.steps?.[cancel.stepIndex];
  if(!step||stepAttempt(step)!==cancel.attempt||step.status!=="running"){
    state.review.cancel={request:cancel.request,pending:false,sessionId:null,stepIndex:-1,attempt:null,requested:false};
  }
}
function prepareWorkspaceMessage(session){
  if(session.workspace){
    return `Managed workspace ready.\n\nExecution workspace: ${session.workspace.executionRoot}\nCurrent checkpoint: ${session.workspace.currentCheckpointId??"initial"}\nBase OID: ${session.workspace.baseOid}`;
  }
  return `Prepare isolated workspace before previews, retries, or filesystem restore.\n\nSource project: ${session.projectRoot}`;
}
function retryConfirmationMessage(session,step,index,attempt){
  return `Restore baseline and retry?\n\nTarget: Step ${index+1} · ${step.title} [${step.id}]\nAttempt: ${attempt.id}\nBaseline OID: ${attempt.baseline.oid}\nExecution root: ${session.workspace?.executionRoot??session.projectRoot}\n\nThe partial result remains as historical evidence.\nProceed?`;
}
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

function utf8Bytes(text){return new TextEncoder().encode(text).length;}
function isPlainObject(value){
  if(value===null||typeof value!=="object"||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}
function isPreviewState(value){
  if(!isPlainObject(value)||!previewStates.has(value.state)||!Number.isInteger(value.latestSequence)||value.latestSequence<0)return false;
  if(value.actualUrl!==undefined&&typeof value.actualUrl!=="string")return false;
  if(value.diagnostic!==undefined&&typeof value.diagnostic!=="string")return false;
  if(value.config!==undefined){
    if(!isPlainObject(value.config)||!Array.isArray(value.config.command)||!value.config.command.every((argument)=>typeof argument==="string"))return false;
    if(value.config.cwd!==undefined&&typeof value.config.cwd!=="string")return false;
  }
  if(value.error!==undefined){
    if(!isPlainObject(value.error))return false;
    if(value.error.message!==undefined&&typeof value.error.message!=="string")return false;
  }
  return true;
}
function utf8Suffix(text,maxBytes){
  const characters=Array.from(text);
  let suffix="";
  let bytes=0;
  for(let index=characters.length-1;index>=0;index-=1){
    const character=characters[index];
    const size=utf8Bytes(character);
    if(bytes+size>maxBytes)break;
    suffix=character+suffix;
    bytes+=size;
  }
  return suffix;
}
function isTerminalEvent(event){
  return event?.type==="terminal.output"
    &&Number.isInteger(event.sequence)
    &&event.sequence>0
    &&/^(?:preview:(?:source|target)|step:\d+)$/.test(event.source)
    &&["stdout","stderr"].includes(event.stream)
    &&typeof event.text==="string";
}
function boundTerminalEvents(events){
  const ordered=[...new Map(events.filter(isTerminalEvent).map((event)=>[event.sequence,event])).values()]
    .sort((left,right)=>left.sequence-right.sequence);
  let bytes=ordered.reduce((total,event)=>total+utf8Bytes(event.text),0);
  while(ordered.length>1&&bytes>terminalClientLimit){
    bytes-=utf8Bytes(ordered.shift().text);
  }
  if(ordered.length&&bytes>terminalClientLimit){
    const event=ordered[0];
    ordered[0]={...event,text:utf8Suffix(event.text,terminalClientLimit)};
  }
  return ordered;
}
function applyRuntimeSnapshot(envelope,owner){
  if(state.runtime.eventSource!==owner||state.runtime.sessionId!==state.active?.id)return;
  if(!isPreviewState(envelope?.source)||!isPreviewState(envelope?.target)||!Array.isArray(envelope.events)||!Number.isInteger(envelope.latestSequence)||envelope.latestSequence<0)return;
  state.runtime.source=envelope.source;
  state.runtime.target=envelope.target;
  state.runtime.events=boundTerminalEvents(envelope.events);
  state.runtime.latestSequence=Math.max(envelope.latestSequence,state.runtime.events.at(-1)?.sequence??0);
  renderMigration(state.active);
}
function applyPreviewState(envelope,owner){
  if(state.runtime.eventSource!==owner||state.runtime.sessionId!==state.active?.id)return;
  if(envelope?.type!=="preview.state"||envelope.sessionId!==state.runtime.sessionId||!["source","target"].includes(envelope.slot)||!Number.isInteger(envelope.sequence)||envelope.sequence<1||!isPreviewState(envelope.state))return;
  const current=state.runtime[envelope.slot];
  if(envelope.sequence<=(current?.latestSequence??0))return;
  state.runtime[envelope.slot]={...envelope.state,latestSequence:envelope.sequence};
  renderPreviewOnly(state.active,envelope.slot);
}
function applyTerminalOutput(envelope,owner){
  if(state.runtime.eventSource!==owner||state.runtime.sessionId!==state.active?.id||!isTerminalEvent(envelope))return;
  if(envelope.sequence<=state.runtime.latestSequence)return;
  state.runtime.events=boundTerminalEvents([...state.runtime.events,envelope]);
  state.runtime.latestSequence=envelope.sequence;
  renderTerminalOnly(state.active);
}
function resetRuntime(sessionId=null){
  if(state.runtime.eventSource){
    state.runtime.eventSource.onmessage=null;
    state.runtime.eventSource.close();
  }
  state.runtime.sessionId=sessionId;
  state.runtime.source=null;
  state.runtime.target=null;
  state.runtime.events=[];
  state.runtime.latestSequence=0;
  state.runtime.filter="all";
  state.runtime.eventSource=null;
  state.runtime.requests.source+=1;
  state.runtime.requests.target+=1;
  state.runtime.pending={source:false,target:false};
  state.runtime.refresh={source:0,target:0};
}
function previewDetails(session,slot){
  const runtime=state.runtime.sessionId===session.id?state.runtime[slot]:null;
  return runtime??{state:"loading",actualUrl:"about:blank",latestSequence:0};
}
function previewCard(session,slot){
  return `<section class="panel preview-card preview-${slot}" data-preview-card="${slot}">${previewCardContent(session,slot)}</section>`;
}
function renderPreviewOnly(session,slot){
  const card=$("#migration-view").querySelector(`[data-preview-card="${slot}"]`);
  if(!card){renderMigration(session);return;}
  card.innerHTML=previewCardContent(session,slot);
}
function previewRequiresWorkspace(session){
  return session?.workbench==="migration"&&session.workspace==null;
}
function previewCardContent(session,slot){
  const preview=previewDetails(session,slot);
  const label=session.metadata[`${slot}Label`]??(slot==="source"?"Source":"Target");
  const command=preview.config?.command?.join(" ")??"No preview service configured";
  const cwd=preview.config?.cwd??".";
  const pending=state.runtime.pending[slot];
  const unavailable=preview.state==="unconfigured";
  const active=["starting","running","stopping"].includes(preview.state);
  const needsWorkspace=previewRequiresWorkspace(session);
  const url=safePreviewUrl(preview.actualUrl);
  const diagnostic=needsWorkspace?"Prepare workspace to enable managed previews.":preview.diagnostic??preview.error?.message??"No runtime diagnostic.";
  return `<div class="panel-title preview-card-title"><span>${escapeHtml(label)}</span><span class="preview-status state-${escapeHtml(preview.state)}" role="status" aria-live="polite" aria-label="${slot==="source"?"Source":"Target"} preview status">${escapeHtml(preview.state)}</span></div><div class="preview-card-meta"><code>${escapeHtml(command)}</code><small>cwd: ${escapeHtml(cwd)}</small><small>${escapeHtml(diagnostic)}</small><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a></div><div class="preview-actions"><button type="button" data-preview-action="start" data-slot="${slot}" aria-label="Start ${slot} preview" ${needsWorkspace||pending||active||unavailable?"disabled":""}>Start</button><button type="button" data-preview-action="stop" data-slot="${slot}" aria-label="Stop ${slot} preview" ${needsWorkspace||pending||!active?"disabled":""}>Stop</button><button type="button" data-preview-action="restart" data-slot="${slot}" aria-label="Restart ${slot} preview" ${needsWorkspace||pending||unavailable?"disabled":""}>Restart</button><button type="button" data-preview-action="refresh" data-slot="${slot}" aria-label="Refresh ${slot} preview" ${url==="about:blank"?"disabled":""}>Refresh</button></div><iframe class="preview" data-preview="${slot}" title="${escapeHtml(label)} preview" sandbox="allow-scripts allow-forms" src="${escapeHtml(url)}"></iframe>`;
}
function filteredTerminalEvents(session){
  const filter=state.runtime.filter;
  if(filter==="source")return state.runtime.events.filter((event)=>event.source==="preview:source");
  if(filter==="target")return state.runtime.events.filter((event)=>event.source==="preview:target");
  if(filter==="step")return state.runtime.events.filter((event)=>event.source===`step:${session.cursor}`);
  return state.runtime.events;
}
function terminalPanelContent(session){
  const events=filteredTerminalEvents(session);
  const filters=[["all","All live output"],["source","Source preview"],["target","Target preview"],["step","Current step"]];
  const lines=events.map((event)=>`<span class="terminal-line ${event.stream}"><span class="terminal-prefix">[${escapeHtml(event.source)}][${escapeHtml(event.stream)}]</span> ${escapeHtml(event.text)}</span>`).join("");
  return `<div class="panel-title terminal-heading"><span>Live runtime output</span><span>${state.runtime.latestSequence?`SEQ ${state.runtime.latestSequence}`:"WAITING"}</span></div><div class="terminal-filters" role="group" aria-label="Filter live terminal output">${filters.map(([value,label])=>`<button type="button" data-terminal-filter="${value}" aria-pressed="${state.runtime.filter===value}">${label}</button>`).join("")}</div><div class="panel-body terminal" data-terminal-scroll><pre aria-label="Live runtime terminal output" aria-live="polite">${lines||"No live output for this filter."}</pre></div>`;
}
function terminalPanel(session){
  return `<section class="panel live-terminal" data-runtime-terminal>${terminalPanelContent(session)}</section>`;
}
function renderTerminalOnly(session){
  const panel=$("#migration-view").querySelector("[data-runtime-terminal]");
  if(!panel){renderMigration(session);return;}
  const scroll=panel.querySelector("[data-terminal-scroll]");
  const priorTop=scroll?.scrollTop??0;
  const follow=!scroll||scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<24;
  panel.innerHTML=terminalPanelContent(session);
  const next=panel.querySelector("[data-terminal-scroll]");
  if(next)next.scrollTop=follow?next.scrollHeight:priorTop;
}
function reviewLanguage(path){
  if(typeof path!=="string")return"plain";
  if(path.endsWith(".html"))return"html";
  if(path.endsWith(".css"))return"css";
  if(path.endsWith(".js"))return"js";
  if(path.endsWith(".json"))return"json";
  return"plain";
}
function syntaxSegments(text,language){
  const segments=[];
  const push=(start,end,className="")=>{
    if(end<=start)return;
    segments.push({text:text.slice(start,end),className});
  };
  if(language==="html"){
    const pattern=/(&lt;\/?)([^&]+?)(&gt;)/g;
    let index=0;
    for(const match of text.matchAll(pattern)){
      const start=match.index??0;
      const prefixEnd=start+match[1].length;
      const tagEnd=prefixEnd+match[2].length;
      const matchEnd=start+match[0].length;
      push(index,start);
      push(start,prefixEnd);
      push(prefixEnd,tagEnd,"syntax-tag");
      push(tagEnd,matchEnd);
      index=matchEnd;
    }
    push(index,text.length);
    return segments;
  }
  if(language==="js"||language==="json"){
    const pattern=/("(?:\\.|[^"\\])*")|\b(const|let|var|function|return|if|else|true|false|null)\b/g;
    let index=0;
    for(const match of text.matchAll(pattern)){
      const start=match.index??0;
      const matchEnd=start+match[0].length;
      push(index,start);
      push(start,matchEnd,match[1]?"syntax-string":"syntax-keyword");
      index=matchEnd;
    }
    push(index,text.length);
    return segments;
  }
  return[{text,className:""}];
}
function searchRanges(text,search){
  if(!search)return[];
  const needle=search.toLowerCase();
  const haystack=text.toLowerCase();
  const ranges=[];
  for(let index=0;index<haystack.length;){
    const start=haystack.indexOf(needle,index);
    if(start===-1)break;
    ranges.push([start,start+needle.length]);
    index=start+needle.length;
  }
  return ranges;
}
function renderSyntaxPiece(text,className,marked){
  if(!text)return"";
  const content=marked?`<mark>${text}</mark>`:text;
  return className?`<span class="${className}">${content}</span>`:content;
}
function renderReviewText(text,path,search){
  const lines=String(text??"").split("\n");
  const bounded=lines.length>reviewRenderLineLimit?lines.slice(0,reviewRenderLineLimit):lines;
  const language=reviewLanguage(path);
  return {
    html:bounded.map((line)=>{
      const escaped=escapeHtml(line);
      const ranges=searchRanges(escaped,search);
      let html="";
      let offset=0;
      for(const segment of syntaxSegments(escaped,language)){
        const segmentStart=offset;
        const segmentEnd=segmentStart+segment.text.length;
        let cursor=segmentStart;
        for(const [start,end] of ranges){
          if(end<=segmentStart||start>=segmentEnd)continue;
          if(cursor<start)html+=renderSyntaxPiece(segment.text.slice(cursor-segmentStart,start-segmentStart),segment.className,false);
          const markedStart=Math.max(cursor,start);
          const markedEnd=Math.min(segmentEnd,end);
          if(markedStart<markedEnd)html+=renderSyntaxPiece(segment.text.slice(markedStart-segmentStart,markedEnd-segmentStart),segment.className,true);
          cursor=markedEnd;
          if(cursor>=segmentEnd)break;
        }
        if(cursor<segmentEnd)html+=renderSyntaxPiece(segment.text.slice(cursor-segmentStart),segment.className,false);
        offset=segmentEnd;
      }
      return `<span class="review-line${ranges.length?" match":""}">${html||"&nbsp;"}</span>`;
    }).join(""),
    limited:lines.length>reviewRenderLineLimit,
    language,
    matches:search?lines.filter((line)=>escapeHtml(line).toLowerCase().includes(search.toLowerCase())).length:0,
  };
}
function renderUnifiedDiff(diff,search){
  const oldText=String(diff.old?.text??"");
  const newText=String(diff.new?.text??"");
  const oldRendered=renderReviewText(oldText,diff.oldPath??diff.path,search);
  const newRendered=renderReviewText(newText,diff.newPath??diff.path,search);
  const limited=oldRendered.limited||newRendered.limited;
  return `<div class="review-unified"><pre class="review-code syntax-demo-${escapeHtml(reviewLanguage(diff.path))}">${oldRendered.html}${newRendered.html}</pre></div>${limited?`<div class="review-truncated"><strong>Rendered first ${reviewRenderLineLimit} lines.</strong>Open the file externally if you need the full patch body.</div>`:""}`;
}
function renderSideBySideDiff(diff,search){
  const oldRendered=renderReviewText(diff.old?.text??"",diff.oldPath??diff.path,search);
  const newRendered=renderReviewText(diff.new?.text??"",diff.newPath??diff.path,search);
  return `<div class="review-side-by-side"><section><div class="review-pane-title">Baseline</div><pre class="review-code syntax-demo-${escapeHtml(reviewLanguage(diff.oldPath??diff.path))}">${oldRendered.html}</pre></section><section><div class="review-pane-title">Result</div><pre class="review-code syntax-demo-${escapeHtml(reviewLanguage(diff.newPath??diff.path))}">${newRendered.html}</pre></section></div>${oldRendered.limited||newRendered.limited?`<div class="review-truncated"><strong>Rendered first ${reviewRenderLineLimit} lines.</strong>Open the file externally if you need the full patch body.</div>`:""}`;
}
function reviewFilesMarkup(attempt){
  const files=filesForAttempt(attempt);
  if(!files.length)return`<div class="review-empty">No changed files were captured for this attempt.</div>`;
  return `<div class="review-files" aria-labelledby="review-files-status">${files.map((entry)=>{
    const selected=entry.path===state.review.selectedPath&&attempt.id===state.review.selectedAttemptId;
    const rename=entry.oldPath&&entry.oldPath!==entry.path?`${entry.oldPath} → ${entry.path}`:entry.path;
    return `<button type="button" class="review-file" data-review-attempt-id="${escapeHtml(attempt.id)}" data-review-path="${escapeHtml(entry.path)}" aria-pressed="${selected}"><span><strong class="review-file-path">${escapeHtml(rename)}</strong><span class="review-file-meta">${escapeHtml(entry.status)} · +${escapeHtml(entry.additions)} / -${escapeHtml(entry.deletions)}</span></span><span class="step-pill ${escapeHtml(entry.status)}">${escapeHtml(entry.status)}</span></button>`;
  }).join("")}</div>`;
}
function reviewDiffMarkup(attempt){
  const selectedPath=state.review.selectedPath;
  const selected=filesForAttempt(attempt).find((entry)=>entry.path===selectedPath);
  const activeDiff=state.review.diff&&state.review.diff.attemptId===attempt.id&&state.review.diff.path===selectedPath?state.review.diff:null;
  const modeButtons=`<div class="review-diff-modes"><button type="button" data-diff-mode="unified" aria-pressed="${state.review.diffMode==="unified"}">Unified</button><button type="button" data-diff-mode="side-by-side" aria-pressed="${state.review.diffMode==="side-by-side"}">Side-by-side</button></div>`;
  if(!selected)return `<div class="review-diff" aria-labelledby="review-diff-status"><div class="review-diff-toolbar"><span id="review-diff-status">Review diff</span>${modeButtons}</div><div class="review-empty">Select one changed file to load its bounded diff.</div></div>`;
  let body=`<div class="review-loading">Select a changed file to inspect diff evidence.</div>`;
  if(state.review.diffLoading&&state.review.selectedAttemptId===attempt.id)body=`<div class="review-loading">Loading diff evidence for ${escapeHtml(selected.path)}…</div>`;
  else if(state.review.diffError&&state.review.selectedAttemptId===attempt.id)body=`<div class="review-error">${escapeHtml(state.review.diffError)}</div>`;
  else if(activeDiff?.binary)body=`<div class="review-binary"><strong>Binary file</strong>${escapeHtml(selected.path)} cannot be rendered inline.</div>`;
  else if(activeDiff){
    const search=state.review.diffSearch.trim();
    const rendered=state.review.diffMode==="side-by-side"?renderSideBySideDiff(activeDiff,search):renderUnifiedDiff(activeDiff,search);
    body=`${activeDiff.truncated?`<div class="review-truncated"><strong>Server response truncated.</strong>Inspect the bounded text below or open the file externally.</div>`:""}${rendered}`;
  }
  return `<div class="review-diff" aria-labelledby="review-diff-status"><div class="review-diff-toolbar"><label for="review-diff-search"><span id="review-diff-status">Review diff</span><input id="review-diff-search" type="search" value="${escapeHtml(state.review.diffSearch)}" placeholder="Search loaded diff"></label>${modeButtons}</div>${body}</div>`;
}
function workspaceMarkup(session,attempt){
  const restoreCurrent=reviewCheckpointTarget(session,"initial");
  const restoreAccepted=attempt?.result?.restorable===true?reviewCheckpointTarget(session,attempt.id):null;
  const runningIndex=session.steps.findIndex((step)=>step.status==="running");
  const runningStep=runningIndex===-1?null:session.steps[runningIndex];
  const cancelling=state.review.cancel.sessionId===session.id&&state.review.cancel.stepIndex===runningIndex&&(state.review.cancel.pending||state.review.cancel.requested);
  return `<section class="panel workspace-panel"><div class="panel-title">Workspace identity</div><div class="panel-body workspace-identity" aria-labelledby="workspace-status"><div id="workspace-status" class="workspace-alert ${session.workspace?"workspace-ready":""}"><strong>${session.workspace?"Execution workspace ready":"Workspace not prepared"}</strong>${escapeHtml(prepareWorkspaceMessage(session))}</div><dl class="workspace-grid"><div><dt>Source project</dt><dd>${escapeHtml(session.projectRoot)}</dd></div><div><dt>Execution workspace</dt><dd>${escapeHtml(session.workspace?.executionRoot??"Not prepared")}</dd></div><div><dt>Current checkpoint</dt><dd>${escapeHtml(session.workspace?.currentCheckpointId??"initial")}</dd></div><div><dt>Base OID</dt><dd>${escapeHtml(session.workspace?.baseOid??"Unavailable")}</dd></div></dl><div class="workspace-actions">${restoreCurrent?`<button type="button" class="danger-button" data-restore-checkpoint-id="initial">Restore initial filesystem</button>`:""}${restoreAccepted&&restoreAccepted.checkpointId!=="initial"?`<button type="button" class="danger-button" data-restore-checkpoint-id="${escapeHtml(restoreAccepted.checkpointId)}">Restore accepted filesystem</button>`:""}</div>${runningStep?`<div class="step-actions"><button type="button" class="cancel-step" data-step-action="cancel" data-step-index="${runningIndex}" ${cancelling?"disabled":""}>${cancelling?`Cancellation requested for attempt ${escapeHtml(stepAttempt(runningStep))}`:`Request cancel attempt ${escapeHtml(stepAttempt(runningStep))}`}</button></div>`:""}</div></section>`;
}
function renderMigration(session){
  const attempt=syncReviewSelection(session);
  const command=attempt?.snapshot?.command??session.currentSnapshot?.command;
  $("#migration-view").innerHTML=`<div class="migration-grid"><section class="panel steps-panel"><div class="panel-title">Migration plan</div><div class="panel-body">${session.steps.map((step,index)=>{const dependencies=stepDependencies(step);return `<div class="step ${step.status} ${index===session.cursor?"current":""}"><strong>${index+1}. ${escapeHtml(step.title)}</strong><small>${escapeHtml(step.description)}</small><small>${step.action?escapeHtml(step.action.command.join(" ")):"Observation step"}</small><div class="step-status-row"><span class="step-id">${escapeHtml(step.id??`step-${index+1}`)}</span><span class="step-pill ${escapeHtml(step.status)}">${escapeHtml(step.status.replaceAll("_"," "))}</span><span class="step-pill risk-pill risk-${escapeHtml(stepRisk(step))}">Risk: ${escapeHtml(stepRisk(step))}</span></div><div class="step-meta"><span class="step-attempt">Attempt ${escapeHtml(stepAttempt(step))}</span></div><div class="step-dependencies"><strong>Depends on:</strong> ${escapeHtml(dependencies.length?dependencies.join(", "):"none")}</div></div>`;}).join("")}</div></section><div class="preview-workspace">${previewCard(session,"source")}${previewCard(session,"target")}${terminalPanel(session)}</div>${workspaceMarkup(session,attempt)}<section class="panel review-files-panel"><div class="panel-title">Changed files</div><div class="panel-body">${attempt?reviewFilesMarkup(attempt):`<div class="review-empty">No attempt evidence is selected at this checkpoint.</div>`}</div></section><section class="panel review-diff-panel"><div class="panel-title">Diff evidence</div><div class="panel-body">${attempt?reviewDiffMarkup(attempt):`<div class="review-empty">Run a migration step to capture per-file diff evidence.</div>`}</div></section><section class="panel history-terminal"><div class="panel-title">Historical command output</div><div class="panel-body terminal"><pre>${command?`$ ${escapeHtml(command.command.join(" "))}\n${escapeHtml(command.stdout??"")}${escapeHtml(command.stderr??"")}`:"No command executed at this checkpoint."}</pre></div></section></div>`;
  const reviewDiffSearch=$("#review-diff-search");
  if(reviewDiffSearch)reviewDiffSearch.value=state.review.diffSearch;
}

function isPristineMigration(session){
  return session?.workbench==="migration"&&session.cursor===-1&&session.steps.every((step)=>step.status==="pending")&&session.snapshots.length===0&&session.annotations.length===0;
}

function canEditPlan(session){return isPristineMigration(session);}
function planIssue(path){return state.planEditor.issues.find((issue)=>issue.path===path)?.message??"";}
function inlinePlanError(path){return `<span class="inline-error" data-error-path="${path}">${escapeHtml(planIssue(path))}</span>`;}
function planDependencyIssues(stepIndex){
  return state.planEditor.issues.filter((issue)=>issue.path.startsWith(`/steps/${stepIndex}/dependsOn`));
}

function syncPlanEditorValidation({preserveStatus=false}={}){
  const draft=state.planEditor.draft;
  if(!draft)return;
  const status=$("#plan-editor-status");
  const previousStatus=status.textContent;
  const previousClass=status.className;
  state.planEditor.issues=validatePlanDraft(draft);
  $("#plan-editor-steps").querySelectorAll("[data-error-path]").forEach((element)=>{element.textContent=planIssue(element.dataset.errorPath);});
  $("#plan-editor-save").disabled=state.planEditor.saving||state.planEditor.stale||state.planEditor.issues.length>0;
  if(preserveStatus){status.textContent=previousStatus;status.className=previousClass;}
  else if(state.planEditor.saving){status.textContent="Saving plan without executing commands…";status.className="loading";}
  else if(state.planEditor.stale){status.textContent="Server state changed. This draft can no longer be saved.";status.className="error";}
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
    const dependencyChoices=draft.steps.slice(0,index).map((candidate,candidateIndex)=>`<label><input type="checkbox" data-field="dependsOn" data-step-index="${index}" data-dependency-id="${escapeHtml(candidate.id)}" ${step.dependsOn.includes(candidate.id)?"checked":""} ${locked?"disabled":""}> <span>${escapeHtml(candidate.title.trim()||`Untitled step ${candidateIndex+1}`)} <code>${escapeHtml(candidate.id)}</code></span></label>`).join("");
    const dependencyIssues=planDependencyIssues(index).map((issue)=>`<span class="inline-error" data-error-path="${issue.path}">${escapeHtml(planIssue(issue.path))}</span>`).join("");
    return `<details class="plan-step" open><summary><span class="plan-step-index">${String(index+1).padStart(2,"0")}</span><span class="plan-step-title">${escapeHtml(title)}</span></summary><div class="plan-step-content"><div class="plan-step-actions"><button type="button" data-action="move-up" data-step-index="${index}" aria-label="Move step ${index+1} up" ${locked||index===0?"disabled":""}>↑</button><button type="button" data-action="move-down" data-step-index="${index}" aria-label="Move step ${index+1} down" ${locked||index===last?"disabled":""}>↓</button><button type="button" class="plan-remove" data-action="remove-step" data-step-index="${index}" ${locked?"disabled":""}>Delete</button></div><div class="plan-step-metadata"><div class="plan-risk-grid"><label>Step ID<input type="text" value="${escapeHtml(step.id)}" readonly aria-readonly="true" aria-label="Step ID ${index+1}"></label><label>Risk<select data-field="risk" data-step-index="${index}" ${locked?"disabled":""}><option value="low" ${stepRisk(step)==="low"?"selected":""}>Low</option><option value="medium" ${stepRisk(step)==="medium"?"selected":""}>Medium</option><option value="high" ${stepRisk(step)==="high"?"selected":""}>High</option></select>${inlinePlanError(`/steps/${index}/risk`)}</label></div><fieldset class="plan-dependency-fieldset"><legend class="field-label">Depends on earlier steps</legend><div class="plan-dependency-list">${dependencyChoices||`<span class="plan-dependency-hint">No earlier steps yet.</span>`}</div><div class="plan-dependency-issues">${dependencyIssues}</div></fieldset></div><div class="plan-field-grid"><label>Title<input type="text" data-field="title" data-step-index="${index}" value="${escapeHtml(step.title)}" ${locked?"disabled":""}>${inlinePlanError(`/steps/${index}/title`)}</label><label>Description<textarea data-field="description" data-step-index="${index}" ${locked?"disabled":""}>${escapeHtml(step.description)}</textarea>${inlinePlanError(`/steps/${index}/description`)}</label><label class="plan-field-wide">Expected result<textarea data-field="expected" data-step-index="${index}" ${locked?"disabled":""}>${escapeHtml(step.expected)}</textarea>${inlinePlanError(`/steps/${index}/expected`)}</label></div><label class="plan-action-toggle"><input type="checkbox" data-field="actionEnabled" data-step-index="${index}" ${step.actionEnabled?"checked":""} ${locked?"disabled":""}> Run a command for this step</label><div class="plan-action-fields" ${step.actionEnabled?"":`aria-disabled="true"`}><div class="plan-argv-list">${argv||`<span class="muted">No arguments yet.</span>`}</div>${inlinePlanError(`/steps/${index}/action/command`)}<button type="button" data-action="add-argument" data-step-index="${index}" ${locked||!step.actionEnabled?"disabled":""}>+ Add argument</button><label>Working directory<input type="text" data-field="cwd" data-step-index="${index}" value="${escapeHtml(step.cwd)}" ${locked||!step.actionEnabled?"disabled":""}>${inlinePlanError(`/steps/${index}/action/cwd`)}</label></div></div></details>`;
  }).join("")||`<div class="plan-empty">No plan steps. Add one or save an empty plan.</div>`;
  $("#plan-editor-add").disabled=locked;
  $("#plan-editor-cancel").disabled=false;
  syncPlanEditorValidation({preserveStatus});
}

function invalidatePlanEditor(){
  state.planEditor.dialogGeneration+=1;
  state.planEditor.draft=null;
  state.planEditor.sessionId=null;
  state.planEditor.stale=false;
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
  state.planEditor.stale=false;
  state.planEditor.issues=[];
  renderPlanEditor();
  $("#plan-editor").showModal();
  $(state.planEditor.saving?"#plan-editor-cancel":"#plan-editor-add").focus();
}

async function savePlan(){
  if(state.planEditor.saving||state.planEditor.stale||!state.planEditor.draft||!state.planEditor.sessionId)return;
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
  const owns=!state.planEditor.stale&&$("#plan-editor").open&&generation===state.planEditor.dialogGeneration&&sessionId===state.planEditor.sessionId&&state.active?.id===sessionId;
  if(!owns){if(request===state.planEditor.saveRequest&&state.planEditor.draft&&$("#plan-editor").open)renderPlanEditor();return;}
  if(saveError){renderPlanEditor();$("#plan-editor-status").textContent=saveError.message;$("#plan-editor-status").className="error";return;}
  renderSession(session);
  closePlanEditor();
  refreshSessions().catch((error)=>{$("#health").textContent=`session list refresh failed: ${error.message}`;});
}

function renderSession(session){
  if(state.active?.id&&state.active.id!==session.id)closeRestoreDialog({focusTrigger:false});
  if(state.planEditor.sessionId&&state.planEditor.sessionId!==session.id)closePlanEditor();
  state.active=session;
  state.activeGeneration+=1;
  syncCancelState(session);
  if(state.planEditor.sessionId===session.id){
    state.planEditor.stale=!isPristineMigration(session);
    syncPlanEditorValidation();
  }
  $("#empty").classList.add("hidden");$("#workbench").classList.remove("hidden");
  $("#session-title").textContent=session.title;$("#session-path").textContent=session.projectRoot;
  $("#workbench-badge").textContent=session.workbench==="execution"?"EXECUTION EXPLORER":"MIGRATION CENTER";
  $("#session-status").textContent=session.status;
  const editPlan=$("#edit-plan");
  const prepareWorkspace=$("#prepare-workspace");
  prepareWorkspace.hidden=session.workbench!=="migration";
  prepareWorkspace.disabled=state.sessionAction.pending||Boolean(session.workspace);
  prepareWorkspace.textContent=session.workspace?"Workspace prepared":"Prepare workspace";
  editPlan.hidden=session.workbench!=="migration";
  editPlan.disabled=!canEditPlan(session);
  if(!editPlan.hidden&&editPlan.disabled){
    editPlan.setAttribute("aria-describedby","edit-plan-reason");
    editPlan.setAttribute("title","Plan editing is available only before the migration starts.");
  }else{
    editPlan.removeAttribute("aria-describedby");
    editPlan.removeAttribute("title");
  }
  $("#execution-view").classList.toggle("hidden",session.workbench!=="execution");
  $("#migration-view").classList.toggle("hidden",session.workbench!=="migration");
  if(session.workbench==="execution")renderExecution(session);else renderMigration(session);
  const nextIndex=nextRunnableIndex(session);
  const reviewIndex=awaitingReviewIndex(session);
  const actionPending=state.sessionAction.pending;
  $("#review-controls").classList.toggle("hidden",reviewIndex===-1);
  $("#review-controls").hidden=reviewIndex===-1;
  $("#review-accept").hidden=reviewIndex===-1;
  $("#review-reject").hidden=reviewIndex===-1;
  $("#review-accept").disabled=reviewIndex===-1||actionPending;
  $("#review-reject").disabled=reviewIndex===-1||actionPending;
  if(reviewIndex!==-1){
    $("#review-accept").textContent=`Accept step ${reviewIndex+1}`;
    $("#review-reject").textContent=`Reject step ${reviewIndex+1}`;
  }
  const nextStep=session.steps[nextIndex];
  const needsWorkspace=session.workbench==="migration"&&nextIndex!==-1&&nextStep?.action&&session.workspace==null;
  $("#run-next").classList.toggle("hidden",reviewIndex!==-1||(session.workbench==="execution"&&nextIndex===-1));
  $("#run-next").hidden=reviewIndex!==-1||(session.workbench==="execution"&&nextIndex===-1);
  $("#run-next").disabled=actionPending||nextIndex===-1||session.status==="running"||needsWorkspace;
  $("#run-next").dataset.index=String(nextIndex);
  $("#run-next").textContent=runButtonLabel(session,nextIndex);
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
  resetRuntime(session.workbench==="migration"?session.id:null);
  renderSession(session);
  const sessionEvents=new EventSource(`/api/sessions/${id}/events`);
  state.events=sessionEvents;
  sessionEvents.onmessage=(event)=>{if(state.events!==sessionEvents)return;if(request<state.openSessionRequest)return;const session=JSON.parse(event.data);if(state.active?.id===session.id)renderSession(session);};
  if(session.workbench!=="migration")return;
  const runtimeEvents=new EventSource(`/api/sessions/${id}/runtime/events`);
  state.runtime.eventSource=runtimeEvents;
  runtimeEvents.onmessage=(event)=>{
    if(state.runtime.eventSource!==runtimeEvents||request!==state.openSessionRequest)return;
    let envelope;
    try{envelope=JSON.parse(event.data);}catch{return;}
    if(envelope?.type==="runtime.snapshot")applyRuntimeSnapshot(envelope,runtimeEvents);
    else if(envelope?.type==="preview.state")applyPreviewState(envelope,runtimeEvents);
    else if(envelope?.type==="terminal.output")applyTerminalOutput(envelope,runtimeEvents);
  };
}
async function mutatePreview(slot,action){
  const sessionId=state.runtime.sessionId;
  if(state.active?.workbench!=="migration"||state.active.id!==sessionId||!["source","target"].includes(slot)||!["start","stop","restart"].includes(action)||state.runtime.pending[slot])return;
  const request=++state.runtime.requests[slot];
  const owner=state.runtime.eventSource;
  const baseline=state.runtime[slot]?.latestSequence??0;
  state.runtime.pending[slot]=true;
  renderPreviewOnly(state.active,slot);
  let preview;
  let actionError;
  try{preview=await api(`/api/sessions/${sessionId}/previews/${slot}/${action}`,{method:"POST",body:"{}"});}
  catch(error){actionError=error;}
  if(request!==state.runtime.requests[slot]||state.runtime.sessionId!==sessionId||state.runtime.eventSource!==owner)return;
  state.runtime.pending[slot]=false;
  if(actionError){alert(actionError.message);renderPreviewOnly(state.active,slot);return;}
  const currentSequence=state.runtime[slot]?.latestSequence??0;
  const responseSequence=preview?.latestSequence??0;
  if(currentSequence<=baseline&&responseSequence>=currentSequence)state.runtime[slot]=preview;
  renderPreviewOnly(state.active,slot);
}
function refreshPreview(slot){
  if(!["source","target"].includes(slot)||state.active?.id!==state.runtime.sessionId)return;
  const preview=state.runtime[slot];
  const safe=safePreviewUrl(preview?.actualUrl);
  if(safe==="about:blank")return;
  const url=new URL(safe);
  const token=++state.runtime.refresh[slot];
  url.searchParams.set("_workbench_refresh",String(token));
  $("#migration-view").querySelector(`[data-preview="${slot}"]`)?.setAttribute("src",url.href);
}
async function mutateActiveSession(path,body){
  const sessionId=state.active?.id;
  if(!sessionId||state.sessionAction.pending)return;
  const request=++state.sessionAction.request;
  state.sessionAction.pending=true;
  state.sessionAction.sessionId=sessionId;
  renderSession(state.active);
  const renderGeneration=state.activeGeneration;
  let session;
  let mutationError;
  try{session=await api(path,{method:"POST",body:JSON.stringify(body)});}
  catch(error){mutationError=error;}
  if(request===state.sessionAction.request)state.sessionAction.pending=false;
  if(state.active?.id!==sessionId){if(state.active)renderSession(state.active);return;}
  if(mutationError){alert(mutationError.message);await openSession(sessionId);return;}
  if(state.activeGeneration!==renderGeneration){
    try{await openSession(sessionId);}
    catch(error){
      const candidateNewer=state.active?.id===sessionId&&isCandidateSessionNewer(state.active,session);
      const currentNewer=state.active?.id===sessionId&&isCandidateSessionNewer(session,state.active);
      if(candidateNewer)renderSession(session);
      else if(state.active)renderSession(state.active);
      if(candidateNewer||currentNewer)$("#health").textContent=`session refresh failed: ${error.message}`;
      else alert(error.message);
    }
    await refreshSessions().catch((error)=>{$("#health").textContent=`session list refresh failed: ${error.message}`;});
    return;
  }
  renderSession(session);
  await refreshSessions().catch((error)=>{$("#health").textContent=`session list refresh failed: ${error.message}`;});
}
async function prepareWorkspace(){
  const session=state.active;
  if(session?.workbench!=="migration"||session.workspace)return;
  await mutateActiveSession(`/api/sessions/${session.id}/workspace/prepare`,{});
}
async function loadReviewDiff(attemptId,reviewPath){
  const session=state.active;
  if(session?.workbench!=="migration"||!attemptId||!reviewPath)return;
  const attempt=migrationAttempts(session).find((candidate)=>candidate.id===attemptId);
  if(!attempt||!filesForAttempt(attempt).some((entry)=>entry.path===reviewPath))return;
  state.review.selectedAttemptId=attemptId;
  state.review.selectedPath=reviewPath;
  state.review.diffError="";
  if(state.review.diff?.attemptId===attemptId&&state.review.diff?.path===reviewPath){renderMigration(session);return;}
  state.review.diff=null;
  state.review.diffLoading=true;
  renderMigration(session);
  const request=++state.review.diffRequest;
  let diff;
  let diffError;
  try{diff=await api(`/api/sessions/${session.id}/attempts/${attemptId}/diff?path=${encodeURIComponent(reviewPath)}`);}
  catch(error){diffError=error;}
  if(request!==state.review.diffRequest||state.active?.id!==session.id||state.review.selectedAttemptId!==attemptId||state.review.selectedPath!==reviewPath)return;
  state.review.diffLoading=false;
  if(diffError){
    state.review.diffError=diffError.message;
    renderMigration(session);
    return;
  }
  state.review.diff={...diff,attemptId,path:reviewPath};
  renderMigration(session);
}
async function cancelRunningStep(stepIndex){
  const session=state.active;
  const step=session?.steps?.[stepIndex];
  const attempt=stepAttempt(step);
  if(!session||!step||step.status!=="running"||attempt<1||state.review.cancel.pending||state.review.cancel.requested)return;
  state.review.cancel={...state.review.cancel,request:state.review.cancel.request+1,pending:true,sessionId:session.id,stepIndex,attempt,requested:false};
  const request=state.review.cancel.request;
  renderMigration(session);
  let response;
  let actionError;
  try{response=await api(`/api/sessions/${session.id}/steps/${stepIndex}/cancel`,{method:"POST",body:JSON.stringify({attempt})});}
  catch(error){actionError=error;}
  if(request!==state.review.cancel.request||state.active?.id!==session.id||state.review.cancel.attempt!==attempt)return;
  if(actionError){
    state.review.cancel={...state.review.cancel,pending:false};
    alert(actionError.message);
    renderMigration(session);
    return;
  }
  state.review.cancel={...state.review.cancel,pending:false,requested:response?.status==="cancelling"};
  renderMigration(session);
}
function openRestoreDialog(checkpointId,trigger){
  const session=state.active;
  const target=reviewCheckpointTarget(session,checkpointId);
  if(!target)return;
  state.review.restore.target=target;
  state.review.restore.trigger=trigger;
  state.review.restore.pending=false;
  $("#restore-checkpoint-description").innerHTML=`<strong>${escapeHtml(target.label)}</strong>\nRef: ${escapeHtml(target.ref)}\nOID: ${escapeHtml(target.oid)}\nExecution root: ${escapeHtml(target.executionRoot)}`;
  $("#restore-checkpoint-status").textContent="Restore changes only the managed execution workspace.";
  $("#restore-checkpoint-dialog").showModal();
  $("#restore-checkpoint-cancel").focus();
}
async function confirmRestoreDialog(){
  const session=state.active;
  const target=state.review.restore.target;
  if(!session||!target||state.review.restore.pending)return;
  state.review.restore.pending=true;
  $("#restore-checkpoint-status").textContent=`Restoring ${target.checkpointId} in the managed workspace…`;
  const request=++state.review.restore.request;
  let restored;
  let restoreError;
  try{restored=await api(`/api/sessions/${session.id}/checkpoints/${target.checkpointId}/restore`,{method:"POST",body:JSON.stringify({confirmed:true,expectedOid:target.oid,expectedExecutionRoot:target.executionRoot})});}
  catch(error){restoreError=error;}
  if(request!==state.review.restore.request||state.active?.id!==session.id||state.review.restore.target?.checkpointId!==target.checkpointId)return;
  state.review.restore.pending=false;
  if(restoreError){
    $("#restore-checkpoint-status").textContent=restoreError.message;
    return;
  }
  closeRestoreDialog({focusTrigger:false});
  renderSession(restored);
  $("#session-status").focus?.();
}
async function runCurrentStep(){
  const index=Number($("#run-next").dataset.index);
  const session=state.active;
  const step=session?.steps[index];
  if(!session||!step||index<0)return;
  const retryAttempt=matchingRetryAttempt(session,index);
  if(retryAttempt){
    if(!confirm(retryConfirmationMessage(session,step,index,retryAttempt)))return;
    await mutateActiveSession(`/api/sessions/${session.id}/steps/${index}/run`,{confirmed:true,confirmedRestore:true,expectedAttemptId:retryAttempt.id,expectedBaselineOid:retryAttempt.baseline.oid,expectedExecutionRoot:session.workspace.executionRoot});
    return;
  }
  if((step.action||stepRisk(step)==="high")&&!confirm(confirmationMessage(session,step,index)))return;
  const body=step.action?{confirmed:true}:{};
  if(stepRisk(step)==="high"){
    const highRiskConfirmation={confirmedRisk:true};
    Object.assign(body,highRiskConfirmation);
  }
  await mutateActiveSession(`/api/sessions/${session.id}/steps/${index}/run`,body);
}
async function reviewCurrentStep(body){
  const session=state.active;
  const index=awaitingReviewIndex(session);
  if(!session||index<0)return;
  await mutateActiveSession(`/api/sessions/${session.id}/steps/${index}/review`,body);
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

$("#prepare-workspace").onclick=prepareWorkspace;
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
  else if(target.dataset.field==="dependsOn"){
    const current=stepDependencies(state.planEditor.draft.steps[stepIndex]);
    const next=target.checked?Array.from(new Set([...current,target.dataset.dependencyId])):current.filter((dependency)=>dependency!==target.dataset.dependencyId);
    state.planEditor.draft=updatePlanStep(state.planEditor.draft,stepIndex,{dependsOn:next});
  }
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

$("#migration-view").onclick=async(event)=>{
  const filter=event.target.closest("[data-terminal-filter]");
  if(filter){
    const value=filter.dataset.terminalFilter;
    if(["all","source","target","step"].includes(value)){
      state.runtime.filter=value;
      if(state.active?.workbench==="migration")renderTerminalOnly(state.active);
    }
    return;
  }
  const diffMode=event.target.closest("[data-diff-mode]");
  if(diffMode){
    const value=diffMode.dataset.diffMode;
    if(["unified","side-by-side"].includes(value)){
      state.review.diffMode=value;
      if(state.active?.workbench==="migration")renderMigration(state.active);
    }
    return;
  }
  const reviewFile=event.target.closest("[data-review-path]");
  if(reviewFile){
    await loadReviewDiff(reviewFile.dataset.reviewAttemptId,reviewFile.dataset.reviewPath);
    return;
  }
  const restoreControl=event.target.closest("[data-restore-checkpoint-id]");
  if(restoreControl){
    openRestoreDialog(restoreControl.dataset.restoreCheckpointId,restoreControl);
    return;
  }
  const stepAction=event.target.closest("[data-step-action]");
  if(stepAction?.dataset.stepAction==="cancel"){
    await cancelRunningStep(Number(stepAction.dataset.stepIndex));
    return;
  }
  const control=event.target.closest("[data-preview-action]");
  if(!control)return;
  const {slot,previewAction:action}=control.dataset;
  if(action==="refresh"){refreshPreview(slot);return;}
  await mutatePreview(slot,action);
};
$("#migration-view").oninput=(event)=>{
  if(event.target.id!=="review-diff-search")return;
  state.review.diffSearch=event.target.value;
  if(state.active?.workbench==="migration")renderMigration(state.active);
};
$("#restore-checkpoint-cancel").onclick=()=>{if(!state.review.restore.pending)closeRestoreDialog();};
$("#restore-checkpoint-confirm").onclick=confirmRestoreDialog;

$("#logic-demo").onclick=()=>createExample("logic-trace").catch((error)=>alert(error.message));
$("#migration-demo").onclick=()=>createExample("migration-demo").catch((error)=>alert(error.message));
$("#session-file").onchange=async(event)=>{try{const input=JSON.parse(await event.target.files[0].text());const session=await api("/api/sessions",{method:"POST",body:JSON.stringify(input)});await refreshSessions();await openSession(session.id);}catch(error){alert(error.message);}event.target.value="";};
$("#run-next").onclick=async()=>runCurrentStep();
$("#review-accept").onclick=async()=>reviewCurrentStep({decision:"accept"});
$("#review-reject").onclick=async()=>reviewCurrentStep({decision:"reject"});
$("#previous").onclick=()=>seek(state.active.cursor-1);$("#next").onclick=()=>seek(state.active.cursor+1);$("#latest").onclick=()=>seek(Number($("#latest").dataset.index));
$("#note-form").onsubmit=async(event)=>{event.preventDefault();const text=$("#note-text").value.trim();if(!text)return;renderSession(await api(`/api/sessions/${state.active.id}/annotations`,{method:"POST",body:JSON.stringify({stepIndex:state.active.cursor,text})}));$("#note-text").value="";};

try{const health=await api("/api/health");state.onboarding.allowedRoot=typeof health.allowedRoot==="string"?health.allowedRoot:"";$("#health").textContent="● engine online";$("#allowed-root").textContent=state.onboarding.allowedRoot;await refreshSessions();}catch(error){$("#health").textContent=`offline: ${error.message}`;}
await refreshRecentProjects();
