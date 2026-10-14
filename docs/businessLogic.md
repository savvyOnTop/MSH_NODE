# CathAID — Complete Business Logic

> **Role of this document (added 2026-10-14):** this is the **product requirements / target behaviour** for cathaid-api. It describes how CathAID is *supposed to work*. Status tags (**[Built]**, **[Partial]**, **[Not built]**, **[Disabled]**) describe the reference product, NOT this repo. Policy: the data model is designed for everything here (incl. gaps); build order delivers [Built] parity first, gaps in later phases. Engineering design lives in [backendMLD.md](backendMLD.md) (§ "Reconciliation with businessLogic.md" maps each section here to a phase). Cross-health-system concerns (cross-tenant transfer, independent EMS shared across tenants) are deferred and will be designed when that phase starts.

As of 2026-10-14. Business rules only. Status tags: **[Built]**, **[Partial]**, **[Not built]**, **[Disabled]**.

## Contents
1. What CathAID is
2. Organisations, people and roles
3. Onboarding and setup
4. Clinical workflows (templates)
5. Case management
6. Case team, case managers and escalations
7. Epic integration
8. Group chat
9. Calls and video
10. Scheduling: Amion, rosters, availability
11. Hospital-to-hospital transfer
12. EMS and ambulances
13. Notifications
14. Permissions and visibility
15. AI features
16. Audit, monitoring and reporting
17. Background jobs
18. Open gaps

---

## 1. What CathAID is

CathAID coordinates **time-critical emergencies** — STEMI heart attacks, stroke, trauma, vascular and custom pathways — across a health system. When a patient comes in, CathAID:

- opens a **case** that follows the hospital's agreed **care pathway** stage by stage,
- automatically pulls together the **right on-call team** for each stage,
- gives that team a **case chat**, **voice calls** and **group video**,
- pre-fills patient data from **Epic** and produces an **AI chart review**,
- **escalates** when time runs out or a vital sign is dangerous,
- handles **transfers** between hospitals and **ambulances** (911 pre-alerts and inter-facility transport) with live tracking.

Clients: **admin web app** (setup and oversight) and **mobile app** (clinicians and ambulance crews; push, ringing, background GPS).

---

## 2. Organisations, people and roles

### 2.1 Organisations
| Organisation | Meaning |
|---|---|
| **Tenant** | A health system. Owns hospitals and decides which diagnoses its hospitals may treat. |
| **Facility** | A hospital. Has an address (auto-mapped to coordinates), time zone, scheduling mode (CathAID roster or Amion). |
| **Department** | Unit in a hospital (ED, cath lab, ICU…). Flags: **Receives EMS alerts** (= the ED), **Is Transfer Center**. |
| **Department role** | A role in a department; can be marked **Department Head**. |
| **Department group** | A team inside a department (e.g. "ED · Night Nurses"). Its roles must be a subset of the department's roles. |
| **EMS provider** | Ambulance organisation with its fleet and crew. |
| **Diagnosis type** | STEMI, Stroke, Trauma, Vascular, Custom. Platform defaults plus tenant-specific ones. |

### 2.2 System roles
| Role | Responsibilities |
|---|---|
| Super / platform admin | Runs the platform, platform-level templates and audit. |
| Tenant admin | Creates hospitals, invites hospital admins, sets allowed diagnoses, manages Amion, views all tenant cases, links the tenant's EMS provider. |
| Hospital (facility) admin | Departments, groups, staff, workflow adoption and role assignment, rosters, time-off approval, group join approvals, facility cases. |
| Clinician (tenant user) | Raises and works cases, chats, calls, manages own availability and schedule. |
| Case monitor | Intended read-only oversight of cases, metrics, QA. **[Partial]** — role exists without case access. |
| Scheduler admin | On-call schedules. |
| EMS admin | Runs an ambulance provider; accepts or declines ambulance requests and assigns crew. |
| EMS user (crew) | Ambulance crew: EMT, AEMT, Paramedic, First Responder, Driver Only. |

### 2.3 Workflow roles
Separate from system roles. Each care pathway defines its own clinical roles (e.g. ED Physician, Interventional Cardiologist, Accepting MD, Cath Lab Nurse, Case Manager). A clinician is **assigned** workflow roles at a specific hospital. A clinician can hold roles in several workflows and hospitals and switches **workspace** (active hospital + workflow) in the app.

---

## 3. Onboarding and setup

### 3.1 Health system and hospitals — [Built]
1. Tenant admin creates hospitals; addresses are geocoded.
2. Tenant admin limits which diagnoses each hospital may treat.
3. Tenant admin invites a hospital admin per hospital (with permission sets).

### 3.2 Departments and groups — [Built]
1. Hospital admin creates departments (unique names within the hospital), department roles and groups.
2. Marks the ED (**Receives EMS alerts**), the Transfer Center, and **Department Head** roles.
3. **Group joining:**
   - A clinician requests to join a group at their own hospital, choosing a role the group allows.
   - No duplicate pending request; not already a member; group and department must be active.
   - Hospital admin approves or rejects (reason required). Rules re-checked at decision time.
   - Admin can change a member's role or deactivate the membership.
4. Each group is mirrored as a **chat roster** so it can be added to a case chat in one click.

### 3.3 Users — [Built]
- **Invite:** a single accept link; already-registered people are joined automatically. Accepting creates the user's profile and role records.
- **Permission sets:** capabilities ticked at platform, tenant or hospital level are combined into the user's access. Changing them forces re-login.
- **Workflow assignment:** hospital admin assigns workflow roles; the workflow must be adopted by that hospital.
- **Profile:** user (or tenant admin) edits profile; email and roles are not editable there.
- **Deactivation:** soft. Hospital admins cannot deactivate tenant admins or people outside their hospitals.
- **Workspace:** user picks active hospital + workflow; this scopes their case lists. Can set a default workflow.

---

## 4. Clinical workflows (templates)

### 4.1 What a template contains — [Built]
| Part | Meaning |
|---|---|
| Stages | Ordered steps. Lifecycle: initial / intermediate / final / terminal. Kind: form-fill, decision, action, alert, terminal. Each has a time limit (SLA). |
| Stage roles | **Main actor** (owns the stage), secondary, participating (paged), visible-to, editable-by. |
| Roles | Clinical roles with: which hospital they staff (origin / destination / any), **on-call required**, **full case access**. |
| Data fields | text, number, select, multi-select, date, date-time, checkbox, yes/no, **ECG upload**, **vitals form**. Required flag, edit permission, link to the clinical field catalogue (for Epic pre-fill). |
| Transitions | Buttons to move between stages: label, style (primary / secondary / danger), order, automatic. |
| Escalation rules | Time-based or data-based; action notify / add to team / code blue. |
| Condition rules | Data checks (=, ≠, <, >, ≤, ≥, contains) combined with AND / OR. |
| Notifications | Per stage and role: sound, retries, channels. |
| Permissions | Per role, from a catalogue: raise, complete, accept, list, view, edit. |

Templates are **single-hospital** or **cross-hospital** (origin → destination, e.g. spoke hospital → PCI centre).

### 4.2 Authoring — [Built]
- **AI generation:** admin types a protocol or uploads a PDF/DOCX → AI drafts the full pathway in the background → admin gives feedback and regenerates → **applies** the draft, which creates all stages, roles, fields, transitions, rules.
- AI never invents permission names; it reuses the catalogue or derives from it.
- Every new template automatically gets a **Case Manager** role with full view/edit of all stage data.
- **Clone** copies the whole template. **Share** within the health system. **Grant edit access** to others.
- **Scope:** platform, tenant or hospital template.

### 4.3 Adoption and versions — [Partial]
- Hospital admin **adopts** a template: one active workflow per hospital per diagnosis; diagnosis must be allowed for the hospital.
- **New version:** old adoption deactivated, version + 1; existing cases keep the version they started on.
- **Gap:** adopters currently share one template, so one hospital's edit affects all. **Planned:** adoption creates a **private copy** linked to the original. **[Not built]**

---

## 5. Case management

### 5.1 What a case holds
- **Identity:** case number (c-####).
- **Patient:** first name, last name, date of birth (required), MRN, Epic patient id.
- **Workflow and location:** template, origin hospital, destination hospital (cross-hospital only).
- **Current stage**, its fields, and **all clinical data** captured so far.
- **SLA due time** for the current stage.
- **Raised by**, **raised as** (workflow role or department role), raise time, close time.
- Links to EMS alert / transfer, AI chart review.
- **No priority or severity field. [Not built]**
- Diagnosis comes from the workflow, not the case.

### 5.2 Statuses
| Status | How reached |
|---|---|
| Pending | Raised but entry stage has no way forward yet. |
| Active | Raised and moved past the entry stage, or an "accept" decision taken. |
| Closed | A final / terminal stage reached (treatment done, discharged). |
| Cancelled | Moved to a stage whose name contains "Reject". |
| Transferred | Patient moved to another hospital and that hospital opened its own case. |

No reopen, no standalone close/cancel button — status only changes through stage transitions. **[Not built]**
Closed and cancelled cases are **frozen**: no edits.

### 5.3 Raising a case — [Built]
**Raise Alert form:**
1. If the user cannot raise, a block message explains why.
2. **Raised as** — shown if the user belongs to an ED department (workflow role vs department role).
3. **Workflow** — chosen if the user has more than one; otherwise auto-picked.
4. **Destination hospital** — only for cross-hospital workflows (same health system, active, has adopted the workflow; own hospital allowed).
5. Optional link to an **EMS alert** or **transfer**.
6. **Patient:** name, DOB, MRN. Entering the MRN looks the patient up in Epic and fills name, DOB, phone, first medical contact time and location.
7. Optional first-stage clinical data.

**Minimum to raise:** patient name and MRN; other stage data can be filled later.

**Allowed only if:**
- the user's workflow role is permitted to act in the first stage;
- destination rules hold (required for cross-hospital, forbidden for single-hospital);
- a department raise is by an active member of an ED at a hospital that adopted the workflow;
- an alert-linked raise uses an acknowledged alert not already turned into a case, by an ED member of the destination.

**Immediately after raising:**
- case number and origin hospital stamped; raiser and time recorded;
- case moves past the entry stage → **Active**;
- raiser joins the team under their real role;
- linked EMS alert / transfer updated.

**In the background:**
- team built for the first stage;
- **case chat** created;
- escalation timers started;
- **Epic** data fills the first stage; **AI chart review** generated.

### 5.4 Working a stage — [Built]
**Case screen tabs:** Current Stage · Patient Details (previous stages + call summaries) · Timeline · Team · Chat · Chart Review · Restricted.

Current Stage shows:
- transfer banners, ambulance map (if any), pending escalation timers,
- the stage's fields,
- **Save Details** (save without moving on),
- **Submit** / decision buttons (one per transition, e.g. Accept / Decline).

**Who can move the case forward:**
- anyone with a **complete** permission (normal stage) or **accept** permission (decision stage) for that workflow; otherwise
- the stage's **main actor**, with participating roles as fallback.
- Required fields must be filled (yes/no and checkbox excluded).

**Who can edit a field:**
- **Case managers:** any field on an open case.
- Others: only fields their role is allowed to edit in that field's stage; if no roles are listed, anyone on the case. Must be able to view the field first.

**Entering a new stage:**
- team updated with the new stage's roles,
- old timers cancelled, new ones started,
- new stage's people notified,
- timeline event written.

### 5.5 Accepted vs completed
- **Case accepted:** single-hospital case — first time it becomes Active. Cross-hospital case — when the **Accepting MD** takes the accept decision.
- **Case completed:** when it closes.
- Each sent once, to the case team.

### 5.6 Timeline — [Built]
Records: case created, field submitted, decision, stage change, data update, team assignment, alert fired, escalation, notification, closed — with who did it.

### 5.7 Uploads
- **ECG upload** field — **[Built]**.
- Angiogram, documents, images — **[Not built]**.

### 5.8 Case lists — [Built]
| Who | List | Shows |
|---|---|---|
| Clinician | My Cases | Cases in the active workspace where they are on the team; all workflow cases if they have the list permission; incoming cross-hospital cases. "Needs action" badge on cases waiting for them. |
| Hospital admin | Facility Cases | All cases of their hospital; diagnosis filter. |
| Tenant admin | Tenant Cases | All cases of the health system; filters by hospital, workflow, diagnosis. |
| Super admin | All Cases / Dashboard | Global; status and SLA filters. |
| ED members | EMS Cases | See §12.5. |
| Case monitor | — | **[Not built]** |

Counters: active cases per workflow, cases by stage.

---

## 6. Case team, case managers and escalations

### 6.1 Building the team — [Built]
For each role in the stage:
1. Pick the hospital the role staffs (origin, destination or any).
2. If the role is **on-call required**: use Amion coverage swap → Amion/CathAID on-call schedule; if nobody, fall back to everyone assigned that role.
3. Otherwise / then apply availability:
   - an approved **swap** wins;
   - else everyone **rostered** for that weekday;
   - else all assignees minus anyone on **approved time off** (pending requests don't count).
4. If **nobody** is available → nobody paged, **coverage gap** alert to hospital admins.
5. Each member records *why* they were picked (rostered, override, fallback, gap…).

### 6.2 Case managers — [Built]
- Anyone holding the Case Manager role (or a role with full case access) at the hospital.
- Automatically added to every case of their hospital — and of the destination hospital for cross-hospital cases.
- A newly assigned manager is added to all open cases at once.
- Powers: view and edit all data, add team members.
- **Gap:** removing a manager's assignment doesn't remove them from cases.

### 6.3 Adding / removing members
- Add: case managers only. **[Built]**
- Remove: **[Not built]**.
- Joining the team = joining the case chat.

### 6.4 Escalations — [Built]
| Type | Fires when | Checked |
|---|---|---|
| Time-based | Stage still open after N minutes | Every minute; re-checked that case is still active and on that stage |
| Data-based | Field / vital meets the condition rules | Whenever case data changes |

| Action | Effect |
|---|---|
| Notify | Alert the target roles **and** add them to the team |
| Add to team | Add target roles as members |
| Code blue | Critical alert to the whole team |

- Each rule fires **once per case**.
- Stage SLA is tracked (pending / breached / resolved).
- **Gap:** target lookup is not limited to the case's hospital.

---

## 7. Epic integration — [Built]
- **At raise:** MRN → patient identity, current encounter.
- **First stage fill:** patient, encounter, vitals, medications, conditions; mean arterial pressure calculated. Fills **only empty** fields — never overwrites clinician entries.
- **Rule:** Epic data enters **only at the first stage**; later stages are manual.
- **AI chart review:** a written review of the patient's record, generated once when the case is created.
- **[Not built]:** recent ED admissions search, periodic Epic sync, Epic order-set triggers.

---

## 8. Group chat

### 8.1 Case chat — [Built]
- Every case gets **one chat** ("Case chat") automatically.
- Members = case team. Joining the team adds you; raiser added at creation.
- Only members can read or post.
- Any member can **add people**:
  - by name search,
  - by **department group** (adds the whole group roster at once).
- Any member can remove others, leave, or rename the chat.
- Text messages only (up to 4,000 characters).
- **No editing or deleting messages** — treated as part of the clinical record.

### 8.2 AI catch-up — [Built]
Someone joining a chat that already has messages gets a **private AI summary** of the conversation so far (only they see it).

### 8.3 Chat alerts — [Built]
- Every other member is notified ("New message on case c-XXXX — sender: text"), unless they have already read up to that message.
- Shown as in-app pop-up (not if the chat is open), browser notification, and phone push.

### 8.4 Not built
Direct messages, standalone department chats, attachments, @mentions, read receipts / unread badges, typing / presence, history beyond 200 messages, locking chat when a case closes.

---

## 9. Calls and video

### 9.1 Voice call to case creator — [Built]
- From the case screen, a team member taps **Call** to ring the person who raised the case.
- Calls are **recorded** and **transcribed**.
- AI writes a **call summary**, shown in the case's Calls tab and the Patient Details "call summaries" panel.
- Web only.

### 9.2 Group video in the case chat — [Built]
- **Group Calls** tab in the case chat.
- Any chat member can **start** a video call → **all other members ring**.
- If a call is already live, starting just joins it.
- Members can **join any time**, **decline**; unanswered rings become **missed**.
- Call ends when the last person leaves.
- Tab shows the live call and the last 20 calls.
- Works on web and mobile (mobile rings while the app is open).
- **[Not built]:** recording of video calls, 1:1 video, ringing when the phone app is closed.

---

## 10. Scheduling: Amion, rosters, availability

Each hospital uses **one** scheduling mode: **CathAID roster** or **Amion**.

### 10.1 Amion — [Partial]
**Setup (tenant / hospital admin):**
1. Enter the hospital's Amion password (stored encrypted) and report settings.
2. First sync runs immediately.

**Hourly:**
1. At :00 — pull the on-call report for every active hospital and store each line as-is.
2. At :10 — convert lines into the **on-call schedule** in the hospital's time zone (overnight shifts handled).

**Matching people and roles:**
- **Amion staff → CathAID user:** exact match first, then AI. High confidence (≥ 80%) auto-matched; rest unmatched. Only links to existing users who already hold a role at that hospital; never creates users.
- **Amion assignment → workflow role:** AI suggests the role.
- **A human must confirm both.** Lines missing a confirmed person or role go to review queues and are not scheduled.

**Screens:** Amion Facility Setup, Roster Queue, Assignment Queue, On-Call Board (admins); **My Schedule** for clinicians ("On call / Covering for X / Covered by Y").

**Effect:** for on-call-required roles, the team is built from the current on-call person (swap → schedule → fallback to static assignments).

**Gaps:**
- **Raising a case ignores Amion** — anyone assigned a role can raise even when not on call (hard vs soft block undecided).
- Swaps derived from Amion **[Not built]**.
- No alert to admins when a sync fails.
- The report request is still pinned to demo dates.

### 10.2 CathAID roster — [Built]
- **Weekly pattern:** each clinician's week as shifts (several per day allowed), effective from–to dates; applies across all their roles at that hospital.
- Admin can publish a roster week and add / edit / remove entries.
- **Swaps:** admin adds a swap for one occurrence (reason required, approved immediately) or a clinician requests one (pending until admin decides). Only approved swaps change paging.
- **Double-booking across hospitals:** resolved by marking the clinician off at the hospital they drop.
- **At-risk shifts:** when time off or roster changes leave a shift uncovered, it is flagged and admins warned.
- Clinicians see My Schedule and an all-hospitals week view.
- **Hospital closures** are display-only; they never stop paging.

### 10.3 Time off — [Built]
- Scope: one hospital or all.
- Repeat: once, daily, weekly, Nth weekday of the month, monthly, yearly; all day or a time window (may cross midnight).
- **Clinician request** → pending → hospital admin(s) notified → approve / reject → clinician notified.
- **Admin entry** → approved immediately.
- Only **approved** time off removes someone from paging.

---

## 11. Hospital-to-hospital transfer (same health system) — [Built]

1. A clinician raises a **transfer alert**, from a case or directly without one.
2. Receiving hospital's ED is notified.
3. Receiving ED **acknowledges** or **declines**; sender notified.
4. Source case shows "transfer pending" and continues meanwhile.
5. Receiving hospital raises its own case from the transfer alert.
6. Cases linked both ways ("Open transferred-to case" / "Open original case"); source case → **Transferred**; sender notified.
7. An ambulance can be requested for the move (§12.3).

**[Not built]:** transfers across health systems; shared patient master record.

---

## 12. EMS and ambulances

### 12.1 Which EMS is allowed
- **Hospital-owned EMS** — **[Built]**, the only kind enabled. Tenant admin links the health system's EMS provider and **finalises**; then the link is locked on both sides.
- **Independent field EMS**, incident dispatch, hospital–EMS relationship requests — **[Disabled]**.
- New EMS provider → its EMS admin is invited automatically. EMS admin invites crew (with certification) and registers ambulances (type BLS / ALS / MICU / SCT).

### 12.2 911 pre-arrival alert (field → ED) — [Built]
1. **Crew raises alert:** picks any active hospital; enters patient name, DOB, sex, chief complaint, vitals (HR, BP, SpO2, RR, GCS), findings, **their available ambulance**, ETA. Ambulance → *Transporting*.
2. **ED alerted with alarm sound** (every active member of the destination ED).
3. **ED acknowledges** and picks the workflow (cannot reject). Crew notified.
4. **Live tracking** with ETA (§12.4).
5. **Approaching** alert at 2 km by road.
6. **Arrived:** crew taps Arrived, or automatic within 150 m. ED alerted with sound; ambulance → *Available*.
7. **Case raised** by an ED member from the alert; alert → *Case created*.

Alert: Raised → Acknowledged → Case created.

### 12.3 Inter-facility ambulance request — [Built]
1. **Transfer Center** (case team member at the sending hospital, or its admin) requests: provider (internal / external), priority (emergent / urgent / scheduled), vehicle type, pickup time, clinical needs. Provider's EMS admins notified.
2. **EMS admin accepts** — chooses **ambulance** (own, active, available, right type), **driver**, **paramedic** → transport created, ambulance *On call*, requester notified. **Or declines** with a reason.
3. **Crew advances the trip** one step at a time; requester notified each step:
   Assigned → En route to pickup → Arrived at pickup *(auto at 150 m)* → Patient picked up → En route to destination → Arrived *(auto at 150 m)* → Completed (ambulance *Available*).

Only the provider's EMS admin assigns its vehicles and crew.

### 12.4 Live tracking — [Built]
- Crew phone sends GPS in the background **only during active travel** (not while waiting, after arrival or completion).
- Every point stored; trip keeps latest position, route, road distance and ETA.
- ETA from real road routing; refreshed every 60 s, every 15 s within 4 km.
- **Map viewers:** the crew (own trip), destination ED members (incoming ambulances), case team (on the case screen).
- **[Not built]:** fleet "current location" from GPS; a Transfer-Center-wide map.

### 12.5 Who sees EMS work at the hospital
- **EMS Alerts** list: destination ED members.
- **EMS Cases** list: ED members only — normal members see cases they raised; **Department Heads** see all EMS cases at the hospital; hospital admins not by default.

### 12.6 Not built
LIFENET 12-lead ECG feed, nearest-hospital picker for crews, pre-alert log.

---

## 13. Notifications

### 13.1 Delivery — [Built]
- Every alert is stored in the user's **Alerts** inbox (marked read when opened).
- Also shown as an **in-app pop-up**, a **browser notification** (tab hidden) and a **phone push**.
- Some alerts play an **alarm sound** (EMS alert, ambulance arrived).
- **[Not built]:** email, SMS, user preferences / mute / quiet hours, retries, per-role sound tiers (configured but not applied), old-alert clean-up.

### 13.2 Catalogue
| Alert | When | Who |
|---|---|---|
| Stage advanced | Case enters a stage | People holding that stage's roles |
| Case accepted | §5.5 | Case team |
| Case completed | Case closed | Case team |
| Team assignment | Added to a case | The person |
| Escalation / Code blue | Rule fires | Target roles / whole team |
| SLA warning / breach | Stage overruns | Relevant team |
| Chat message | New message | Other chat members |
| Incoming group call | Video call started | Other chat members (ring) |
| Coverage gap | No one available for a role | Hospital admins |
| Roster at risk | Shift uncovered | Hospital admins |
| Time-off request / decision | Requested / decided | Admins / clinician |
| Transfer alert / ack / decline / linked | Transfer events | Receiving ED / sender |
| EMS alert 🔔 / acknowledged | 911 alert events | ED / crew |
| Ambulance approaching / arrived 🔔 | 2 km / arrival | Destination ED |
| Ambulance requested / accepted / declined | Request events | EMS admins / requester |
| Transport status | Each trip step | Transfer Center requester |

---

## 14. Permissions and visibility
- **System permissions** — what screens and actions a user can use (raise case, manage hospital cases, manage Amion, mark alert arrived, advance transport…).
- **Workflow permissions** — per workflow role: raise, complete, accept, list, view, edit — and per-field edit rights.
- **Data scoping** — users see only their health system, their hospitals, departments and groups. Chat and calls: members only.
- **Gap:** some workflow-specific permissions (e.g. "can edit shock details") are hard-wired, not generic.

---

## 15. AI features — [Built]
| Feature | What it does |
|---|---|
| Workflow builder | Drafts a full care pathway from a protocol document; revises from feedback |
| Clinical field linking | Links template fields to the clinical catalogue for Epic pre-fill |
| Epic chart review | Written review of the patient's record per case |
| Chat catch-up | Private summary for new chat joiners |
| Call summary | Summary of each recorded call |
| Amion matching | Matches Amion staff to users and assignments to roles (human confirms) |

No general AI assistant. **[Not built]**

---

## 16. Audit, monitoring and reporting
- **Audit log** per health system and a platform audit log; key changes recorded. **[Built]**
- **Feature switch** for field EMS. **[Built]**
- **[Not built]:** door-to-balloon and time metrics, SLA breach reports, QA/QI findings, weekly QA reports, analytics dashboards, case-monitor views.

---

## 17. Background jobs
| Job | When |
|---|---|
| Escalation timer check | Every minute |
| Amion pull | Hourly at :00 |
| Amion → on-call schedule | Hourly at :10 |
| Team build, chat, timers, Epic fill, chart review | On case raise / stage entry |
| Push delivery, chat catch-up, call summary | On the triggering event |

**[Not built]:** alert clean-up, periodic Epic sync, monitoring, QA/QI reports.

---

## 18. Open gaps
1. Adoption should create a private hospital copy of the workflow.
2. Case priority / severity; reopen; manual close / cancel; remove team member; manager clean-up on de-assignment.
3. Angiogram / document / image uploads.
4. Amion-aware raise gate; Amion-derived swaps; sync failure alerts.
5. Chat: DMs, attachments, mentions, read receipts, lock on close.
6. Video recording, 1:1 video, background ringing.
7. Notifications: email, SMS, preferences, retries, sound tiers.
8. Generic workflow permissions.
9. Metrics, door-to-balloon, QA/QI, dashboards, case monitor.
10. Cross-health-system transfer, patient master.
11. EMS: GPS fleet location, Transfer Center map, LIFENET, nearest-hospital picker, independent field EMS.
12. Transfer Center department flagging at each hospital; Transfer Center role provisional.
