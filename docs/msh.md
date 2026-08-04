 8 roles (signup dropdown has 7; ED Resident/PA is admin-provisioned): Referring MD, Referring RN, ED Resident/PA, Fellow, Accepting MD, Accepting
  RN, Transfer Center, CathLab Tech. Plus flags: isSuperUser, displayRole (display override), specialization.

  Specializations (visible + required only when role = Accepting MD): Stemi, CT surgeon, CICU, CHF (src/screens/Signup/constant.js:87-98). Only
  Stemi has client behavior — Accepting MD + Stemi can raise cases.

  Locations — code has 8 real sites + 4 pseudo-locations, not the 7 you listed:
  MSQ, MSH, MSW, MSM, MSB, BHC, MSSN, MSBI + pseudo Floor, MSH ED, Field/FDNY, Outer Hospital (src/utils/getLocationOptions.js:1-14). (Your
  MSC/MSE/MSF/MSS don't exist in code.)

  User object fields: _id, name, firstName, lastName, email, mobile, role, displayRole, specialization, location{_id,name,fullName},
  allowed_location[], isSuperUser, active, photo{key,name}, notification_token/device, apn, type.

  Case status enum (7 values): Pending Review → Under Review → Accepted | Rejected | Reject with transfer ; Accepted → Cancelled | Completed. Active
  bucket = first 3; terminal = last 4. Colors: Under Review blue, Accepted green, Completed violet, Pending orange, rest red.

  ---
  1. Stage: Raise case (AddAlarm)

  Who can raise: Referring MD, ED Resident/PA, or Accepting MD with specialization Stemi (Home/index.js:13). Accepting MD raising stamps
  manual_activation: true; ED Resident/PA stamps is_case_raised_by_edresident_pa: true + on_behalf_of_referringmd.

  Form fields (AddAlarm/constant.js):

  ┌──────────────────────────┬──────────────────────────────┬──────────────────────────────────┬───────────────────────────────────────────────┐
  │           key            │            label             │               type               │                  validation                   │
  ├──────────────────────────┼──────────────────────────────┼──────────────────────────────────┼───────────────────────────────────────────────┤
  │ images                   │ Photos (ECG)                 │ imagePicker                      │ min 1, max 3; upload failure non-blocking     │
  ├──────────────────────────┼──────────────────────────────┼──────────────────────────────────┼───────────────────────────────────────────────┤
  │ on_behalf_of_referringmd │ Referring Attending          │ autoSuggestion (User search,     │ visible only for ED Resident/PA; required     │
  │                          │                              │ role=Referring MD)               │ (but {} initial passes — bug)                 │
  ├──────────────────────────┼──────────────────────────────┼──────────────────────────────────┼───────────────────────────────────────────────┤
  │ patient_name             │ Patient Name                 │ text                             │ required, letters+spaces, min 3               │
  ├──────────────────────────┼──────────────────────────────┼──────────────────────────────────┼───────────────────────────────────────────────┤
  │ dob                      │ Date of Birth MM/DD/YYYY     │ date                             │ required, ≤ today, ≥ today−150y               │
  ├──────────────────────────┼──────────────────────────────┼──────────────────────────────────┼───────────────────────────────────────────────┤
  │ phone_number             │ Phone Number                 │ text                             │ required, exactly 10 digits                   │
  ├──────────────────────────┼──────────────────────────────┼──────────────────────────────────┼───────────────────────────────────────────────┤
  │ first_medical_contact    │ First Medical Contact        │ dateTime                         │ required, ≤ now                               │
  ├──────────────────────────┼──────────────────────────────┼──────────────────────────────────┼───────────────────────────────────────────────┤
  │ location                 │ Patient Location (your       │ dropdown                         │ required; ordered per user's own site         │
  │                          │ "fromLocation")              │                                  │                                               │
  ├──────────────────────────┼──────────────────────────────┼──────────────────────────────────┼───────────────────────────────────────────────┤
  │ toLocation               │ Cath Lab Destination (your   │ dropdown                         │ required; depends on location                 │
  │                          │ "toLocation")                │                                  │                                               │
  └──────────────────────────┴──────────────────────────────┴──────────────────────────────────┴───────────────────────────────────────────────┘

  Key correction to your description: toLocation isn't a free pick of the same list — it's auto-derived on location change via
  locationToCathLabMapping: Field/FDNY→MSH, Outer Hospital→MSH, MSW→MSM, MSQ→MSQ, MSH→MSH, MSM→MSM, MSB→BHC, MSSN→MSSN, MSBI→MSW, BHC→BHC; Floor →
  user's own site. User can still override from the ordered cath-lab list. Accepting MD raising a case gets only Floor as patient location.

  Local vs Transfer: same location = local (no Transfer Center, no EMS); different = transfer (Transfer Center notified, EMS tracked). Client
  decides "local" at reject time as location.name ∈ {MSH ED, Floor} || location._id === toLocation._id.

  Write: _batchSave insert on model Request with _id: "new_<uuid>", the fields above, ecg_images[].

  2. Stage: Raise notification fan-out (server-side)

  Client registers FCM/APNs tokens (_notificationRegistration); recipient computation is backend. Documented rules (matches your description +
  project memory):

  ┌───────────────────────────────────────┬─────────────────────────────────────────────────────────────┬──────────────┬────────────────────────┐
  │               recipient               │                          condition                          │    sound     │         retry          │
  ├───────────────────────────────────────┼─────────────────────────────────────────────────────────────┼──────────────┼────────────────────────┤
  │ Accepting MD of toLocation            │ always                                                      │ special      │ every 2 min until read │
  │                                       │                                                             │ alarm        │                        │
  ├───────────────────────────────────────┼─────────────────────────────────────────────────────────────┼──────────────┼────────────────────────┤
  │ Fellow of toLocation                  │ always                                                      │ special      │ every 2 min            │
  │                                       │                                                             │ alarm        │                        │
  ├───────────────────────────────────────┼─────────────────────────────────────────────────────────────┼──────────────┼────────────────────────┤
  │ Transfer Center (all locations)       │ transfer cases only                                         │ special      │ every 2 min            │
  │                                       │                                                             │ alarm        │                        │
  ├───────────────────────────────────────┼─────────────────────────────────────────────────────────────┼──────────────┼────────────────────────┤
  │ ED Resident/PA of toLocation          │ if location is MSH ED; include raiser if raised by ED       │ silent       │ none                   │
  │                                       │ Resident/PA                                                 │              │                        │
  ├───────────────────────────────────────┼─────────────────────────────────────────────────────────────┼──────────────┼────────────────────────┤
  │ Referring MD                          │ on rejection only                                           │ alarm        │ none                   │
  ├───────────────────────────────────────┼─────────────────────────────────────────────────────────────┼──────────────┼────────────────────────┤
  │ Accepting RN, CathLab Tech, Referring │ joined on accept                                            │ normal       │ every 2 min within 2   │
  │  RN                                   │                                                             │              │ hrs                    │
  └───────────────────────────────────────┴─────────────────────────────────────────────────────────────┴──────────────┴────────────────────────┘

  Client-side alarm push behavior: special_sound/notif_sound → sound loops infinitely, system volume forced to 60%, snackbar 30s; video call →
  call_sound, 23s; chat → 4s; generic → 6s (NotificationHandler.js).

  3. Stage: Review → Accept / Reject (Accepting MD only)

  - Opening a Pending Review case as Accepting MD or Fellow fires markAlarmRead + appends user to viewedBy → server promotes to Under Review. App
  never writes "Under Review" itself.
  - Accept: confirm dialog → updateData service (unique — sends full case snapshot), {status:"Accepted"} + timeline entry "Request Accepted".
  - Reject, local case: comment optional (asymmetry — bug-ish) → {status:"Rejected", comments}.
  - Reject, transfer case: radio required — "Reject STEMI & Transfer" → Rejected; "Reject STEMI & Accept Transfer" → Reject with transfer; writes
  rejectWithTransfer + mandatory comment. Referring MD + Transfer Center notified (server); case stays open for Referring MD.
  - Cancel (post-accept, Accepting MD): mandatory comment → {status:"Cancelled", cancelRequest:true, comments}.

  4. Stage: On accept — chat groups + expanded team

  Groups arrive server-built on the request as groups[]: {name, membersId[]} — client never mutates membership. Members per your spec (server
  logic): Reported By, AMD, RRN, ARN, Fellow, CathLab Tech(toLocation). Known group name "MD" (single MD group labeled "Chat").

  Chat (PubNub): message channel <group>-<case_id>, push channel <group>-Notif-<case_id>.
  - Open-chat gate: anyone once Accepted/Completed; during Pending/Under Review only AMD, ED Resident/PA, Fellow, Referring MD, Transfer Center.
  - Send gate is time-based, no role check: active statuses ≤ 7 days from raise/status-update; terminal statuses ≤ 2 days. Outside window →
  read-only transcript.
  - Message types: text, image (resized 1000×1000 JPEG q70 → S3). Persisted to model PubnubChat, paged 50.
  - Chat push sent client-to-client via PubNub with hardcoded production APNs topic org.mountsinai.stemicathaid; suppressed for sender and when that
  chat is open.

  Video calls (OpenTok): Accepting MD card icon calls reported_by (only when someone else accepted); any group member can call any other from group
  roster (presence dot from active). createOpenTokRoom → {apiKey, sessionId, token}; callee gets AcceptRejectCall screen (foreground) or lands
  ├───────────────────────────────────────┼─────────────────────────────────────────────────────────────┼──────────────┼────────────────────────┤
  │ Accepting RN, CathLab Tech, Referring │ joined on accept                                            │ normal       │ every 2 min within 2   │
  │  RN                                   │                                                             │              │ hrs                    │
  └───────────────────────────────────────┴─────────────────────────────────────────────────────────────┴──────────────┴────────────────────────┘

  Client-side alarm push behavior: special_sound/notif_sound → sound loops infinitely, system volume forced to 60%, snackbar 30s; video call →
  call_sound, 23s; chat → 4s; generic → 6s (NotificationHandler.js).

  3. Stage: Review → Accept / Reject (Accepting MD only)

  6c. Shock screening — 8 boolean toggles (your list, confirmed exact keys):
  hypotension (SBP<90 or DBP<60), age_gt_70, need_vasopressure, heart_rate_gt_90, cardiac_arrest, anterior_stemi (on EKG), killip_class_gt_2,
  electrical_instability (VT).

  - Who fills: ED Resident/PA, Referring MD, Referring RN, Accepting RN, Fellow (your "referringMD or referringRN of fromLocation" is narrower than
  code — 5 roles can submit) while shock_approval undefined, status Accepted/Completed.
  - Escalation banner: count > 7 (i.e., all 8) → "Shock score is more than 7. Shock will be activated for MCS and advance therapies post
  confirmation." Client-cosmetic only; actual fan-out to CT surgeon / CICU / CHF specialized AMD+Fellow is backend (those strings appear nowhere in
  client routing — only signup dropdown).
  - Shock approval: Accepting MD only, when criteria answered + shock_approval unset → Approve/Reject writes shock_approval: true|false + timeline
  "Shock Approved"/"Shock Rejected". Toggles lock after decision.

  7. Stage: Cath lab

  - "Patient moved to Cath Lab": Accepting MD only, status Accepted, one-way flag move_to_cathlab: true + move_to_cathlab_On (no timeline entry —
  only action that skips it). Stops the case timer.
  - "Ready to receive patient": Accepting RN only → ready_receive_patient: true + timeline "Cath lab ready to receive patient".
  - Discharge gate (before Discharge/metrics navigation): needs vitals ("Please add Vitals"), needs move_to_cathlab ("Please move to cathlab"), and
  if shock rule fires, shock_approval must be decided ("Shock is not Approved").

  8. Stage: Clinical documentation (post-vitals, status Accepted/Completed/Cancelled)

  Medication (all roles except Transfer Center + CathLab Tech; available once groups exist): 6 Yes/No radios + conditional dosage dropdowns —
  aspirin (81/162/325), brilinta (90/180), heparin (4000), lipitor (40/80), plavix (150/300), zofran (no dosage). Dosage required iff parent = yes;
  no administration timestamps.

  Preprocedural Metrics (declared editors: Accepting MD, Referring MD, ED Resident/PA, Fellow — but isEditable is dead code, everyone can edit):
  - Time metrics (all required dateTime): arrival_time_out_hospital, ekg_time_out_hospital, arrival_time_treat_hospital, ekg_time_treat_hospital
  - initial_clinical_status (Cardiac Arrest yes/no); if yes: cardiac_arrest_time (HH:MM), in_hospital (In/Out Hospital), initial_rhythm, rosc_time
  (HH:MM)

  Discharge Metrics (Accepting MD only, confirm-modal "Discharge"; 32 fields, all required or conditionally required):
  - Discharge Info: discharge_date_time, discharge_disposition (Home | Hospice-Home | Hospice-Healthcare Facility | Acute Care Facility | Other
  Health Care Facility | Expired | AMA | Not Documented/UTD), comfort_measures_only + confort_measures_only_date (sic, if yes)
  - Meds: acei/contraindicated_acei, arb/contraindicated_arb, aspirin_dis/select_dosg(81/162/325)/contraindicated_aspirin,
  - EMS notifications marked read separately (filter ems_id exists vs alarm reads ems_id $exists:false).

  6. Stage: Add Details chain (post-accept, before vitals exist)

  Gate: status Accepted + no heart_rate. Roles: ED Resident/PA, Referring MD, Fellow, Referring RN, Accepting RN, or Accepting MD only if
  manual_activation. Three-step wizard:

  6a. Patient details (PatientDetailEdit): patient_name (required, min 3 letters), dob (required), medical_ref_no (MRN, required), location
  (read-only, seeded). Direct edits later add is_patient_details_updated: true.

  6b. Vitals (EditVitals): heart_rate (BPM, required), composite sbp_dbp_map → flattened to sbp/dbp/map (all 3 required), oxygen_saturation (SaO2 %,
  required), temperature (°C, required). Later edits add is_details_edited: true.

  Shock-case trigger (exact): heart_rate > 90 && ((sbp > 0 && sbp < 90) || (map > 0 && map < 65)) → warning "Heart Rate and SBP/MAP indicates shock
  case. Please initiate shock screening." → button becomes Next → step 6c.

  6c. Shock screening — 8 boolean toggles (your list, confirmed exact keys):
  hypotension (SBP<90 or DBP<60), age_gt_70, need_vasopressure, heart_rate_gt_90, cardiac_arrest, anterior_stemi (on EKG), killip_class_gt_2,
  electrical_instability (VT).

  - Who fills: ED Resident/PA, Referring MD, Referring RN, Accepting RN, Fellow (your "referringMD or referringRN of fromLocation" is narrower than
  code — 5 roles can submit) while shock_approval undefined, status Accepted/Completed.
  - Escalation banner: count > 7 (i.e., all 8) → "Shock score is more than 7. Shock will be activated for MCS and advance therapies post
  confirmation." Client-cosmetic only; actual fan-out to CT surgeon / CICU / CHF specialized AMD+Fellow is backend (those strings appear nowhere in
  client routing — only signup dropdown).
  - Shock approval: Accepting MD only, when criteria answered + shock_approval unset → Approve/Reject writes shock_approval: true|false + timeline
  "Shock Approved"/"Shock Rejected". Toggles lock after decision.

  7. Stage: Cath lab

  - "Patient moved to Cath Lab": Accepting MD only, status Accepted, one-way flag move_to_cathlab: true + move_to_cathlab_On (no timeline entry —
  only action that skips it). Stops the case timer.
  - "Ready to receive patient": Accepting RN only → ready_receive_patient: true + timeline "Cath lab ready to receive patient".
  - Discharge gate (before Discharge/metrics navigation): needs vitals ("Please add Vitals"), needs move_to_cathlab ("Please move to cathlab"), and
  if shock rule fires, shock_approval must be decided ("Shock is not Approved").

  8. Stage: Clinical documentation (post-vitals, status Accepted/Completed/Cancelled)

  Medication (all roles except Transfer Center + CathLab Tech; available once groups exist): 6 Yes/No radios + conditional dosage dropdowns —
  aspirin (81/162/325), brilinta (90/180), heparin (4000), lipitor (40/80), plavix (150/300), zofran (no dosage). Dosage required iff parent = yes;
  no administration timestamps.

  Preprocedural Metrics (declared editors: Accepting MD, Referring MD, ED Resident/PA, Fellow — but isEditable is dead code, everyone can edit):
  - Time metrics (all required dateTime): arrival_time_out_hospital, ekg_time_out_hospital, arrival_time_treat_hospital, ekg_time_treat_hospital
  - initial_clinical_status (Cardiac Arrest yes/no); if yes: cardiac_arrest_time (HH:MM), in_hospital (In/Out Hospital), initial_rhythm, rosc_time
  (HH:MM)

  Discharge Metrics (Accepting MD only, confirm-modal "Discharge"; 32 fields, all required or conditionally required):
  - Discharge Info: discharge_date_time, discharge_disposition (Home | Hospice-Home | Hospice-Healthcare Facility | Acute Care Facility | Other
  Health Care Facility | Expired | AMA | Not Documented/UTD), comfort_measures_only + confort_measures_only_date (sic, if yes)
  - Meds: acei/contraindicated_acei, arb/contraindicated_arb, aspirin_dis/select_dosg(81/162/325)/contraindicated_aspirin,
  antiplatelet/antiplatelet_dropdown(Clopidrogel|Prasugrel|Ticagrelor|Ticlopidine|Other)/other_free_text/antiplate_reason,
  anticoagulation/anticoagulation_dropdown(Warfarin|Rivaroxaban|Apixaban|Dabigatran|Other)/other_free_text_anticoagulation/anticoagulation_reason,
  beta_blocker, statin/medication_dropdown(8 statins+Other)/dosage_dropdown(1–80)/intensity_dropdown(Low|Moderate|High)/statin_free_text,
  high_intensity_medication, raas (if EF<40%), discharge_on_asa, adjunctive (yes/no/na)
  - Referrals: life_vest, cardiac_rehab_ref, smoking_cessation, fellow_appointment (follow-up 1-2 wks)

  Completed status is set server-side after discharge; app never writes it.

  9. Cross-cutting

  Full Request object (everything client touches): identity _id, case_id, patient_name, dob, phone_number, medical_ref_no; lifecycle status,
  cancelRequest, rejectWithTransfer, comments, move_to_cathlab(_On), ready_receive_patient, request_status[]{type,date}, status_updated_on,
  alarm_raise_on, first_medical_contact, _createdOn; routing location{}, toLocation{}, groups[], assign_ems{}; people reported_by, accepted_by,
  rejected_by, viewedBy[], on_behalf_of_referringmd; flags manual_activation, is_case_raised_by_edresident_pa, is_patient_details_updated,
  is_details_edited; media ecg_images[]; vitals heart_rate, sbp, dbp, map, oxygen_saturation, temperature; 8 shock booleans + shock_approval;
  preprocedural + medication + discharge fields above.

  Timeline (request_status[].type) values written by app: Request Accepted / Rejected / Cancelled, Shock Approved / Rejected, Cath lab ready to
  receive patient. (Case raise/EMS milestones added server-side.)

  List windows: Active Alarms = terminal ≤2 days or active ≤7 days; History = inverse. Chat window mirrors this.

  Metrics (per project memory): Door-to-Balloon <90 min goal (timer = first_medical_contact → move_to_cathlab_On or status change),
  alert-to-acceptance, weekly Sunday 4:30 AM UTC 60+ column Excel to leadership.

  Transport: single POST /invoke endpoint; services _find/_save/_batchSave/updateData/markAlarmRead/...; models Request, User, Location,
  EmsTracking, VideoCall, App_Notification, PatientLogs, PubnubChat. Real-time = socket.io onServerUpdate (insert/update/remove by _id) per screen.
  Every change audited in PatientLogs (HIPAA).

  Notable bugs found while extracting (worth a ticket each)

  1. Shock escalation counter starts at 0, never seeded from saved criteria — ">7" banner only fires if all 8 toggled in one session; can go
  negative.
  2. isEditable vs editable mismatch → Preprocedural/Discharge role read-only rules are dead code.
  3. on_behalf_of_referringmd required-validation passes with empty {}.
  4. Chat messageIdGenerator never returns the uuid → all local messages get _id: undefined.
  5. EMS detail table ignores its declared date formats — raw ISO strings render.
  List windows: Active Alarms = terminal ≤2 days or active ≤7 days; History = inverse. Chat window mirrors this.

  Metrics (per project memory): Door-to-Balloon <90 min goal (timer = first_medical_contact → move_to_cathlab_On or status change),
  alert-to-acceptance, weekly Sunday 4:30 AM UTC 60+ column Excel to leadership.

  Transport: single POST /invoke endpoint; services _find/_save/_batchSave/updateData/markAlarmRead/...; models Request, User, Location,
  EmsTracking, VideoCall, App_Notification, PatientLogs, PubnubChat. Real-time = socket.io onServerUpdate (insert/update/remove by _id) per screen.
  Every change audited in PatientLogs (HIPAA).
