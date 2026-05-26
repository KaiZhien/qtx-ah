# Demo Script

"So what we've built is the data and intelligence layer for the QuantumTX program at Alexandra Hospital.

The hospital has been running the therapy program and collecting patient assessment data, but it was all sitting in an Excel sheet with no systematic analysis. We've changed that.

**The pipeline** takes 1,716 patient records, cleans them, classifies each patient by condition, and computes whether they actually improved after treatment. Key numbers: 69.5% of patients who complete follow-up respond to treatment, we can predict at intake whether someone will respond with 74% accuracy, and we can predict dropout with near-perfect accuracy — which turns out to reflect real clinical signals about patient engagement.

**The application is built in four layers:**

1. **Database and ingestion** — done. Patient data lives in a proper database, importable via API, no more static files. You can see all 1,715 patients loaded here.

2. **Patient knowledge graph** — in progress. Every clinic visit creates a new session record and trend signals compute automatically — is this patient's gait speed improving, have they plateaued, how many sessions in are they.

3. **AI reasoning layer** — next. Claude reasoning over each patient's own history. Proactive insights after every new session, and a Q&A interface where clinicians can ask things like 'why is this patient not progressing?'

4. **Frontend** — the clinician-facing web app you're looking at now. The Fall Risk predictor is fully live — enter a patient's details and it hits the backend and returns a risk score with the top contributing factors. The per-patient clinical timeline is being built next.

The goal is to give clinicians a living, intelligent view of each patient across their whole treatment journey."
