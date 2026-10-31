# Cornell Heart Care Traffic Light Tool — research notes

Source: archived copy (Apr 15, 2026 homepage capture) of Cornell Home Care's
Heart Care eCourse, since the live site's certificate is expired. The
eCourse footer notes MIT License, Copyright (c) 2022 Cornell University.
These notes summarize the tool's structure for adapting it to CareTask.
They are NOT copied content and NOT clinical rules for real patients.

## What it is

A caregiver-facing questionnaire for heart-failure home care. The caregiver
picks the patient's most concerning symptom, answers follow-ups, and the
tool places the patient in a zone. Audience: home-care workers, not the
patient alone; escalation contacts are the supervisor, agency nurse,
patient's doctor, or 911.

## Symptoms asked about

Shortness of breath, chest discomfort, fatigue, weight gain, confusion,
leg swelling, lightheadedness and falls.

## Follow-up questions

Is the symptom new? Worse at rest or with activity? What other symptoms
occur with it? Medication / water-pill use? Relevant changes (diet, a fall)?

## Zones

- Green: patient stable. Action: keep monitoring, watch for changes.
  Green is the default when no yellow or red trigger is met.
- Yellow, two tiers:
  - "Consider asking for help" — help from a supervisor may be needed.
  - "Call for help" — help from a supervisor should be obtained.
  - Example of "Call for help": weight gain of 2–3 lbs in a day, or over
    5 lbs in a week.
  - Examples of "Consider asking for help": a new symptom; shortness of
    breath worse at rest; chest discomfort at rest; shortness of breath
    with fever, or with two or more of cough, leg swelling, mucus, wheeze;
    chest discomfort with shortness of breath or racing heart; fatigue
    worse than usual or with fever; new confusion or confusion with two or
    more of slurred speech, facial asymmetry, worsening weakness, fever,
    painful/increased urination, lightheadedness; new lightheadedness, a
    fall that day, or high/low blood pressure.
- Red: symptoms worsening, changes worrisome. Action: call 911 / EMS as
  this may be an emergency; while waiting, take vitals, notify family,
  notify agency supervisor.
  - Red examples (narrow and specific): severe chest pain with shortness
    of breath; shooting pain down the arm or left-side chest pain with
    chest discomfort; loss of consciousness with confusion.

## Monitoring advice the tool gives

Walk the patient to check whether breathlessness worsens with activity;
take vitals and oxygen saturation, call for help if O2 sat is below 95%;
press a swollen leg, call for help if the imprint remains; for chest
symptoms check blood pressure, breathing and pulse, call for help if
pulse is over 100.

## What CareTask has now (2026-10-27)

Zone guide only: Green / Yellow / Red with a meaning and a clinician-worded
action each, on the registry. No questionnaire, no two-tier yellow, no
symptom-trigger rules. A questionnaire sorter would be a separate build,
and any zone output stays assistive — the clinician always decides.
