{
  "metadata": {
    "version": 1,
    "name": "Major Trauma Activation — Level 1 Trauma Center",
    "clinical_category": "trauma",
    "draft_origin": "ai",
    "ai_source_type": "text",
    "tenant": "Mass General Brigham",
    "facility": "MGH Main Campus"
  },

  "roles": [
    {
      "id": "EMS_PARAMEDIC",
      "name": "EMS Paramedic",
      "permissions": ["case.raise", "case.view", "stage.capture_data", "media.upload"],
      "can_raise_alarm": true, "scheduling_required": false, "default_sound": "silent"
    },
    {
      "id": "TRAUMA_SURGEON",
      "name": "Trauma Surgeon (Team Lead)",
      "permissions": ["case.view", "case.accept", "case.reject", "case.add_team", "stage.advance", "stage.rollback", "stage.capture_data", "media.view", "alert.acknowledge"],
      "can_raise_alarm": false, "scheduling_required": true, "default_sound": "critical_alarm"
    },
    {
      "id": "ED_ATTENDING",
      "name": "ED Attending",
      "permissions": ["case.raise", "case.view", "stage.capture_data", "stage.advance", "media.view", "alert.acknowledge"],
      "can_raise_alarm": true, "scheduling_required": false, "default_sound": "critical_alarm"
    },
    {
      "id": "TRAUMA_NURSE",
      "name": "Trauma Nurse (Primary)",
      "permissions": ["case.view", "stage.capture_data", "media.upload", "alert.acknowledge"],
      "can_raise_alarm": false, "scheduling_required": true, "default_sound": "critical_alarm"
    },
    {
      "id": "ANESTHESIOLOGIST",
      "name": "Anesthesiologist",
      "permissions": ["case.view", "stage.capture_data", "alert.acknowledge"],
      "can_raise_alarm": false, "scheduling_required": true, "default_sound": "critical_alarm"
    },
    {
      "id": "BLOOD_BANK_TECH",
      "name": "Blood Bank Technician",
      "permissions": ["case.view", "stage.capture_data", "alert.acknowledge"],
      "can_raise_alarm": false, "scheduling_required": true, "default_sound": "standard_alarm"
    },
    {
      "id": "RADIOLOGY_TECH",
      "name": "Radiology Technician",
      "permissions": ["case.view", "stage.capture_data", "media.upload", "alert.acknowledge"],
      "can_raise_alarm": false, "scheduling_required": true, "default_sound": "standard_alarm"
    },
    {
      "id": "OR_COORDINATOR",
      "name": "OR Coordinator",
      "permissions": ["case.view", "stage.capture_data", "alert.acknowledge"],
      "can_raise_alarm": false, "scheduling_required": true, "default_sound": "standard_alarm"
    },
    {
      "id": "NEUROSURGEON_ON_CALL",
      "name": "Neurosurgeon (On-Call)",
      "permissions": ["case.view", "alert.acknowledge"],
      "can_raise_alarm": false, "scheduling_required": true, "default_sound": "critical_alarm"
    },
    {
      "id": "TRAUMA_COORDINATOR",
      "name": "Trauma Program Coordinator",
      "permissions": ["case.view", "metrics.view", "metrics.export", "audit.view"],
      "can_raise_alarm": false, "scheduling_required": false, "default_sound": "silent"
    }
  ],

  "stages": [
    {
      "id": "prehospital_alert",
      "name": "Pre-Hospital Trauma Alert",
      "order": 1,
      "type": "action",
      "is_entry": true,
      "description": "EMS transmits mechanism, vitals, ETA. Custom steps capture field interventions specific to this center's trauma bundle.",
      "actor_roles": ["EMS_PARAMEDIC"],
      "required_data_fields": [
        { "id": "mechanism",   "label": "Mechanism of Injury", "type": "text",        "required": true },
        { "id": "vitals",      "label": "Field Vitals",        "type": "vitals_form", "required": true },
        { "id": "eta_minutes", "label": "ETA (minutes)",       "type": "number",      "required": true },
        { "id": "gcs",         "label": "Glasgow Coma Scale",  "type": "number",      "required": true }
      ],
      "actions": [
        {
          "id": "log_tourniquet_applied",
          "type": "custom",
          "label": "Log Tourniquet Applied",
          "description": "Field-specific: record tourniquet placement + time for downstream limb-ischemia tracking.",
          "allowed_roles": ["EMS_PARAMEDIC"],
          "required_data_fields": [
            { "id": "tourniquet_site", "label": "Tourniquet Site", "type": "select", "required": true, "options": ["left_arm", "right_arm", "left_leg", "right_leg"] },
            { "id": "tourniquet_time", "label": "Time Applied",    "type": "datetime", "required": true }
          ],
          "transitions_to": null
        },
        {
          "id": "log_prehospital_blood",
          "type": "custom",
          "label": "Log Pre-Hospital Blood Given",
          "description": "Center-specific: field blood products, to reconcile with in-hospital MTP.",
          "allowed_roles": ["EMS_PARAMEDIC"],
          "required_data_fields": [
            { "id": "units_given", "label": "Units Given", "type": "number", "required": true }
          ],
          "transitions_to": null
        },
        {
          "id": "activate_trauma",
          "type": "system",
          "permission_code": "stage.advance",
          "label": "Activate Trauma Team",
          "allowed_roles": ["EMS_PARAMEDIC"],
          "transitions_to": "bay_preparation"
        }
      ],
      "notifications": [
        { "role_id": "ED_ATTENDING",   "sound_type": "critical_alarm", "retry_interval_minutes": 1, "max_retries": 5, "channels": ["push", "in_app"] },
        { "role_id": "TRAUMA_SURGEON", "sound_type": "critical_alarm", "retry_interval_minutes": 2, "max_retries": 10, "channels": ["push", "in_app", "sms"] }
      ],
      "sla_minutes": 15
    },
    {
      "id": "bay_preparation",
      "name": "Trauma Bay Preparation",
      "order": 2,
      "type": "action",
      "description": "Team preps the bay before patient arrival. This center requires an explicit readiness checklist — each item is a custom action, all must be logged before the bay is declared ready.",
      "actor_roles": ["TRAUMA_NURSE", "ED_ATTENDING", "ANESTHESIOLOGIST", "BLOOD_BANK_TECH", "RADIOLOGY_TECH"],
      "required_data_fields": [],
      "actions": [
        {
          "id": "confirm_airway_cart_ready",
          "type": "custom",
          "label": "Confirm Airway Cart Ready",
          "description": "Difficult-airway cart checked and at bedside.",
          "allowed_roles": ["ANESTHESIOLOGIST", "TRAUMA_NURSE"],
          "transitions_to": null
        },
        {
          "id": "confirm_rapid_infuser_primed",
          "type": "custom",
          "label": "Confirm Rapid Infuser Primed",
          "description": "Level-1 rapid infuser primed and warmed.",
          "allowed_roles": ["TRAUMA_NURSE"],
          "transitions_to": null
        },
        {
          "id": "confirm_mtp_on_standby",
          "type": "custom",
          "label": "Confirm MTP On Standby",
          "description": "Massive Transfusion Protocol cooler requested from blood bank.",
          "allowed_roles": ["BLOOD_BANK_TECH", "TRAUMA_NURSE"],
          "required_data_fields": [
            { "id": "cooler_id", "label": "MTP Cooler ID", "type": "text", "required": true }
          ],
          "transitions_to": null
        },
        {
          "id": "confirm_ct_scanner_held",
          "type": "custom",
          "label": "Confirm CT Scanner Held",
          "description": "CT suite cleared and reserved for incoming trauma.",
          "allowed_roles": ["RADIOLOGY_TECH"],
          "transitions_to": null
        },
        {
          "id": "confirm_warmer_on",
          "type": "custom",
          "label": "Confirm Bay Warmer On",
          "description": "Overhead warmer + warmed fluids ready (hypothermia prevention).",
          "allowed_roles": ["TRAUMA_NURSE"],
          "transitions_to": null
        },
        {
          "id": "bay_ready",
          "type": "system",
          "permission_code": "stage.advance",
          "label": "Bay Ready — Await Arrival",
          "allowed_roles": ["ED_ATTENDING", "TRAUMA_NURSE"],
          "requires_prior_actions": ["confirm_airway_cart_ready", "confirm_rapid_infuser_primed", "confirm_mtp_on_standby", "confirm_ct_scanner_held", "confirm_warmer_on"],
          "transitions_to": "primary_survey"
        }
      ],
      "notifications": [
        { "role_id": "BLOOD_BANK_TECH", "sound_type": "standard_alarm", "retry_interval_minutes": 2, "max_retries": 3 },
        { "role_id": "RADIOLOGY_TECH",  "sound_type": "standard_alarm", "retry_interval_minutes": 2, "max_retries": 3 }
      ],
      "sla_minutes": 10
    },
    {
      "id": "primary_survey",
      "name": "Primary Survey (ABCDE)",
      "order": 3,
      "type": "action",
      "description": "Trauma surgeon leads the ABCDE primary survey. Each ABCDE step is logged as a custom action so timing and findings are captured discretely for QA.",
      "actor_roles": ["TRAUMA_SURGEON", "ED_ATTENDING", "TRAUMA_NURSE"],
      "required_data_fields": [
        { "id": "arrival_time", "label": "Patient Arrival Time", "type": "datetime", "required": true }
      ],
      "actions": [
        {
          "id": "log_airway_assessed",
          "type": "custom",
          "label": "A — Airway Assessed / Secured",
          "allowed_roles": ["TRAUMA_SURGEON", "ANESTHESIOLOGIST"],
          "required_data_fields": [
            { "id": "airway_status", "label": "Airway", "type": "select", "required": true, "options": ["patent", "adjunct_placed", "intubated", "surgical_airway"] }
          ],
          "transitions_to": null
        },
        {
          "id": "log_breathing_assessed",
          "type": "custom",
          "label": "B — Breathing Assessed",
          "allowed_roles": ["TRAUMA_SURGEON", "ED_ATTENDING"],
          "required_data_fields": [
            { "id": "chest_finding", "label": "Chest Finding", "type": "select", "required": true, "options": ["normal", "tension_pneumo_decompressed", "chest_tube_placed", "flail_segment"] }
          ],
          "transitions_to": null
        },
        {
          "id": "log_circulation_assessed",
          "type": "custom",
          "label": "C — Circulation / Hemorrhage Control",
          "allowed_roles": ["TRAUMA_SURGEON", "TRAUMA_NURSE"],
          "required_data_fields": [
            { "id": "hemorrhage_source", "label": "Hemorrhage Source", "type": "select", "required": false, "options": ["none", "external", "thoracic", "abdominal", "pelvic", "long_bone"] }
          ],
          "transitions_to": null
        },
        {
          "id": "log_disability_assessed",
          "type": "custom",
          "label": "D — Disability (Neuro) Assessed",
          "allowed_roles": ["TRAUMA_SURGEON", "ED_ATTENDING"],
          "required_data_fields": [
            { "id": "pupils", "label": "Pupils", "type": "select", "required": true, "options": ["equal_reactive", "unequal", "fixed_dilated"] }
          ],
          "transitions_to": null
        },
        {
          "id": "log_exposure_done",
          "type": "custom",
          "label": "E — Exposure / Environment",
          "allowed_roles": ["TRAUMA_NURSE"],
          "transitions_to": null
        },
        {
          "id": "activate_mtp",
          "type": "custom",
          "label": "Activate Massive Transfusion Protocol",
          "description": "Center-specific one-tap MTP activation; blood bank auto-notified via notifications on this action.",
          "allowed_roles": ["TRAUMA_SURGEON"],
          "transitions_to": null
        },
        {
          "id": "primary_survey_complete",
          "type": "system",
          "permission_code": "stage.advance",
          "label": "Primary Survey Complete",
          "allowed_roles": ["TRAUMA_SURGEON"],
          "requires_prior_actions": ["log_airway_assessed", "log_breathing_assessed", "log_circulation_assessed", "log_disability_assessed", "log_exposure_done"],
          "transitions_to": "disposition_decision"
        }
      ],
      "notifications": [],
      "sla_minutes": 20
    },
    {
      "id": "disposition_decision",
      "name": "Disposition Decision",
      "order": 4,
      "type": "decision",
      "description": "Trauma surgeon decides the destination. Three system branches, each terminal-bound or forwarding.",
      "actor_roles": ["TRAUMA_SURGEON"],
      "required_data_fields": [],
      "actions": [
        {
          "id": "to_or",
          "type": "system",
          "permission_code": "stage.advance",
          "label": "Emergent Surgery — To OR",
          "allowed_roles": ["TRAUMA_SURGEON"],
          "transitions_to": "or_handoff"
        },
        {
          "id": "to_ct",
          "type": "custom",
          "label": "Stable — To CT First",
          "description": "Center-specific: stable patients routed through CT before admission; logged, stays in stage for re-decision after imaging.",
          "allowed_roles": ["TRAUMA_SURGEON"],
          "transitions_to": null
        },
        {
          "id": "reject_transfer_out",
          "type": "system",
          "permission_code": "case.reject",
          "label": "Refer / Transfer to Another Center",
          "allowed_roles": ["TRAUMA_SURGEON"],
          "required_data_fields": [
            { "id": "transfer_reason", "label": "Reason", "type": "text", "required": true }
          ],
          "transitions_to": "transferred_out"
        }
      ],
      "notifications": [
        { "role_id": "OR_COORDINATOR", "sound_type": "standard_alarm", "retry_interval_minutes": 2, "max_retries": 3 }
      ],
      "sla_minutes": 15
    },
    {
      "id": "or_handoff",
      "name": "OR Handoff & Closure",
      "order": 5,
      "type": "action",
      "description": "Handoff to OR team; case closed once handoff checklist logged.",
      "actor_roles": ["TRAUMA_SURGEON", "OR_COORDINATOR", "ANESTHESIOLOGIST"],
      "required_data_fields": [],
      "actions": [
        {
          "id": "confirm_consent_or_emergency",
          "type": "custom",
          "label": "Confirm Consent / Emergency Exception",
          "allowed_roles": ["TRAUMA_SURGEON"],
          "required_data_fields": [
            { "id": "consent_type", "label": "Consent", "type": "select", "required": true, "options": ["patient", "surrogate", "emergency_exception"] }
          ],
          "transitions_to": null
        },
        {
          "id": "confirm_or_team_briefed",
          "type": "custom",
          "label": "Confirm OR Team Briefed (WHO Checklist)",
          "allowed_roles": ["OR_COORDINATOR", "ANESTHESIOLOGIST"],
          "transitions_to": null
        },
        {
          "id": "close_case",
          "type": "system",
          "permission_code": "case.close",
          "label": "Handoff Complete — Close Trauma Case",
          "allowed_roles": ["TRAUMA_SURGEON"],
          "requires_prior_actions": ["confirm_consent_or_emergency", "confirm_or_team_briefed"],
          "transitions_to": "closed"
        }
      ],
      "notifications": []
    },
    {
      "id": "closed",
      "name": "Closed",
      "order": 6,
      "type": "terminal",
      "description": "Trauma case closed.",
      "actor_roles": [], "actions": [], "notifications": []
    },
    {
      "id": "transferred_out",
      "name": "Transferred Out",
      "order": 6,
      "type": "terminal",
      "description": "Patient referred/transferred to another facility.",
      "actor_roles": [], "actions": [],
      "notifications": [
        { "role_id": "ED_ATTENDING", "sound_type": "standard_alarm" }
      ]
    }
  ],

  "escalation_rules": [
    {
      "id": "head_injury_neurosurg",
      "name": "Severe Head Injury — Neurosurgery",
      "trigger_condition": {
        "type": "data_field_check",
        "stage_id": "prehospital_alert",
        "rules": [{ "field": "gcs", "operator": "lt", "value": 9 }],
        "logic": "AND"
      },
      "action": "add_team",
      "add_roles": ["NEUROSURGEON_ON_CALL"],
      "notification": { "sound_type": "critical_alarm", "message": "GCS < 9 — Neurosurgery added to trauma case" }
    },
    {
      "id": "mtp_activated_notify",
      "name": "MTP Activated — Blood Bank",
      "trigger_condition": {
        "type": "action_performed",
        "action_id": "activate_mtp"
      },
      "action": "notify",
      "notification": { "sound_type": "critical_alarm", "message": "Massive Transfusion Protocol activated — release MTP cooler", "notify_roles": ["BLOOD_BANK_TECH"] }
    },
    {
      "id": "primary_survey_overdue",
      "name": "Primary Survey Overdue",
      "trigger_condition": { "type": "time_elapsed", "from_stage_id": "primary_survey", "minutes": 20 },
      "action": "escalate",
      "notification": { "sound_type": "critical_alarm", "message": "Primary survey exceeding 20 min", "notify_roles": ["TRAUMA_COORDINATOR", "TRAUMA_SURGEON"] }
    }
  ]
}