# Ownership transfer — QTX cloud resources

> **Status: NOT STARTED.** Every cloud resource this project runs on currently sits on the
> owner's (Reet Mitra's) **personal accounts**. Nothing here contains a secret — credentials
> travel separately through the credential channel (see "Secrets", bottom).
>
> **The standing rule until this transfer completes: no paid tier is enabled on any personal
> account.** The one pending paid decision — Vercel Pro, which is the only thing blocking the
> production deploy — is taken **after** the relevant project is transferred to (or created
> under) a company team, so the subscription starts on a company card. If the team prefers to
> launch without paying, the free-tier alternative is documented in the launch runbook
> (trim the cron list to Hobby's limit; a real code change, not config).

## How to use this file

Fill in the **placeholders** below, send this file (or just the filled table) to the owner,
and the owner executes the right-hand column of each row. Prefer **transfers** over invites:
invites leave the resources — and their billing — on a personal account. Treat any invite
as a bridge measured in weeks.

| Placeholder | Fill in |
|---|---|
| `[GITHUB_ORG]` | Company GitHub organization name (create one if none exists) |
| `[SUPABASE_ORG]` | Company Supabase organization (Dashboard → New organization, on a company email + card) |
| `[VERCEL_TEAM]` | Company Vercel team (create on a company email; Pro goes here if chosen) |
| `[TEAM_EMAILS]` | Emails of the engineers who need access, and who the lead is |
| `[DNS_OWNER]` | Who controls the `quantumtx.com` registrar (needed for email-domain verification) |

## The transfers

| Resource | What it holds | Owner executes | Access to grant |
|---|---|---|---|
| **GitHub repo** `reetmitra/qtx-ah` | All code | Settings → Danger Zone → **Transfer repository** → `[GITHUB_ORG]` (history and the private flag survive). Stopgap: Settings → Collaborators → add `[TEAM_EMAILS]` | `maintain` engineers, `admin` lead |
| **Supabase — ops platform project** (`qtx-ops-platform`) | The platform's production database (fully migrated, 51 tables) | Project Settings → General → **Transfer project** → `[SUPABASE_ORG]`. Do this **before real data lands**. Project ref, URL, keys, data and migration history all survive; nothing in the app changes | `Developer` engineers, `Owner`/`Admin` lead |
| **Supabase — legacy DLMS project** | The live legacy production DB (real users today) | Same per-project transfer to `[SUPABASE_ORG]` while it still serves users | same |
| **Supabase — parked clinician-auth project** | Auth for the parked clinical dashboard | Transfer only if the clinical stack is ever revived; otherwise leave until decommission | — |
| **Vercel projects** (`qtx-ops-platform`, frozen `dlms`, parked `qtx-ah`) | Hosting for platform + legacy + parked dashboard | Project Settings → **Transfer** each project → `[VERCEL_TEAM]`. **Then** take the Pro decision on the company team if that's the chosen launch path | `Member` engineers, `Owner` lead |
| **Railway** (`valiant-spontaneity`) | The **parked** clinical API + its Postgres (parked clinical data). Likely the only recurring personal charge today (~US$5/mo Hobby) | Either: add `[TEAM_EMAILS]` as members and move billing when the clinical stack is revived — or snapshot the Postgres (`pg_dump`) and wind the project down to stop the charge. **Do not delete without the snapshot** | `Member` — only whoever un-parks it |
| **`quantumtx.com` DNS** | Domain + the DNS records email verification needs | Confirm `[DNS_OWNER]` and give them this file's Resend row | registrar-specific |

## Key swaps (no transfer path exists — company accounts + new keys)

| Service | Used by | The swap |
|---|---|---|
| **Anthropic** | Legacy DLMS invoice extraction (live, billing the personal key per use); platform env carries the same key | Team creates a company Anthropic console account → new key → set in Vercel env (both projects) → owner revokes the personal key |
| **Resend** | Platform email (currently unset — email no-ops) and legacy edge-function alerts | Company Resend account → verify `quantumtx.com` (DNS!) → key into Vercel env + Supabase edge-function secrets → owner revokes old key |
| **Voyage** | Parked clinical stack only | Swap only if the clinical stack is revived |

## Secrets

Credentials are **not in this file and not in git**. The owner holds a local vault-ready file
with every secret pre-filled for password-manager import; it travels only through the
credential channel. On import: delete the source file and **rotate the ops database
password** (it transited a chat transcript during setup).

## Current billing state (verified 2026-08-05)

- Vercel: **Hobby (free)** — the deploy is parked precisely because Hobby rejects the 5-minute cron; the upgrade decision belongs to `[VERCEL_TEAM]`, not the personal account.
- Supabase: **Free tier**, both active projects. Consequence: the ops project auto-pauses after ~a week idle (un-pause is a dashboard button); no point-in-time recovery until Pro.
- Railway: personal workspace, parked clinical stack — the one likely recurring charge; see its row above.
- Anthropic: personal key pays for legacy invoice extraction per use — swap early.
- GitHub / Resend / Voyage: no charges today.
