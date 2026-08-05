# Ownership transfer — QTX cloud resources

> **Status: NOT STARTED. The owner will NOT be present to execute these transfers —
> read "Before the owner leaves" below before anything else.** Every cloud resource this
> project runs on currently sits on the owner's (Reet Mitra's) **personal accounts**.
> Nothing here contains a secret — credentials travel separately through the credential
> channel (see "Secrets", bottom).
>
> **The standing rule: no paid tier is enabled on any personal account, ever.** The one
> pending paid decision — Vercel Pro, the only thing blocking the production deploy — is
> taken **after** the relevant project is transferred to (or created under) a company team,
> so the subscription starts on a company card. The team decides and executes this
> themselves; it needs no input from the owner. If the team prefers to launch without
> paying, the free-tier alternative is documented in the launch runbook (trim the cron
> list to Hobby's limit — a real code change, not config).

## Before the owner leaves — the one thing that must happen while they're still reachable

Every transfer below (repo, Supabase projects, Vercel projects) requires **elevated
standing access on the resource's current owner account** to execute — that's how GitHub,
Supabase and Vercel all gate it. Since the owner won't be around when the team is ready to
pull the trigger, **the team can't wait until then to ask** — access has to be granted
*now*, once, so every transfer becomes fully self-service afterward with zero further
owner involvement.

**The full ask, one round-trip:**

1. The team fills in `[GITHUB_USERNAME]`, `[TEAM_EMAILS]`, and names a lead, and sends
   this file (or just this section) to the owner.
2. The owner grants exactly these five things — a few minutes of dashboard clicks, no
   ongoing commitment:

   | Grant | Where | Role needed | Why this role |
   |---|---|---|---|
   | GitHub repo access | [`reetmitra/qtx-ah`](https://github.com/reetmitra/qtx-ah) → Settings → Collaborators → Add `[GITHUB_USERNAME]` | **Admin** | GitHub's own rule: transferring a repo needs admin permission on it — the account doesn't have to own it |
   | Supabase org access | Org `elgvpuanuzrehsizapff` → Team → Invite `[LEAD_EMAIL]` | **Owner** | Only Owner can execute Transfer project; this one invite covers all three projects at once |
   | Vercel team access | Team `reet-mitras-projects` → Settings → Members → Invite `[LEAD_EMAIL]` | **Owner** | Only Owner can transfer a project out of a team |
   | Railway project access | Project `valiant-spontaneity` → Settings → Members → Invite `[LEAD_EMAIL]` | **Admin** | Needed to manage/wind down the project (see its row below — Railway transfer support should be checked live, it may not exist) |
   | `quantumtx.com` registrar | Hand `[DNS_OWNER]` the login via the credential channel, or add them at the registrar | registrar-specific | Needed for Resend/SES domain verification |

   None of these grants move billing — the personal card stays on the hook until the
   **Transfer** step itself runs. That's the point: granting access is safe to do today;
   it just gives the team the standing to act on their own timeline.

3. **Also now, while the owner is still reachable:** the owner revokes the *old* personal
   API keys for Anthropic, Resend and Voyage — but only *after* the team confirms each
   swap-in replacement key works (see "Key swaps" below). Revocation is the one step in
   this whole document that only the owner's own account can do, so it can't be deferred
   to later like the transfers can.

**After steps 2–3, the owner has nothing further to do.** Everything in the table below
runs on the team's own schedule, self-service, with the access already granted.

**Last step, once every transfer below is actually done:** remove the owner's account
from the Supabase org, the Vercel team, and the GitHub repo's collaborator list. An
Owner-level grant left standing after departure is a residual access risk with no
upside — clean it up as part of closing this file out, not as an afterthought.

## How to use the rest of this file

Fill in the remaining **placeholders**, then work down the table whenever the team is
ready — no need to loop the owner back in for any of it.

| Placeholder | Fill in |
|---|---|
| `[GITHUB_ORG]` | Company GitHub organization name (create one if none exists) |
| `[SUPABASE_ORG]` | Company Supabase organization (Dashboard → New organization, on a company email + card) |
| `[VERCEL_TEAM]` | Company Vercel team (create on a company email; Pro goes here if chosen) |
| `[GITHUB_USERNAME]` / `[LEAD_EMAIL]` / `[TEAM_EMAILS]` | The engineer(s) who need access, and who the lead is |
| `[DNS_OWNER]` | Who controls the `quantumtx.com` registrar going forward |

## The transfers (self-service, once access above is granted)

All three Supabase projects live in the owner's personal org `elgvpuanuzrehsizapff`; all three Vercel projects in the personal team `reet-mitras-projects`.

| Resource | What it holds | Team executes (self-service) |
|---|---|---|
| **GitHub repo** [`reetmitra/qtx-ah`](https://github.com/reetmitra/qtx-ah) | All code | As the Admin collaborator granted above: Settings → Danger Zone → **Transfer repository** → `[GITHUB_ORG]` (history and the private flag survive). ⚠️ Everyone clones **fresh** afterward — never a clone predating 2026-07-16 (history was rewritten; an old clone resurrects purged blobs) |
| **Supabase — ops platform project** (`qtx-ops-platform`, ref `yxpxknfdtcpbhohxlhfx`) | The platform's production database (fully migrated, 51 tables) | As the Owner granted above: Project Settings → General → **Transfer project** → `[SUPABASE_ORG]`. Do this **before real data lands**. Project ref, URL, keys, data and migration history all survive; nothing in the app changes |
| **Supabase — legacy DLMS project** (ref `bkvbqopcebfjfiemqdvk`) | The live legacy production DB (real users today) | Same per-project transfer to `[SUPABASE_ORG]` while it still serves users |
| **Supabase — parked clinician-auth project** (ref `dfqipoelibolsyhxircc`) | Auth for the parked clinical dashboard | Transfer only if the clinical stack is ever revived; otherwise leave until decommission |
| **Vercel projects** (`qtx-ops-platform`, frozen `dlms`, parked `qtx-ah`) | Hosting for platform + legacy + parked dashboard | As the Owner granted above: Project Settings → **Transfer** each project → `[VERCEL_TEAM]`. **Then** take the Pro decision on the company team if that's the chosen launch path |
| **Railway** (`valiant-spontaneity`) | The **parked** clinical API + its Postgres (parked clinical data). Likely the only recurring personal charge today (~US$5/mo Hobby) | Check the current Railway dashboard for a project-transfer option (support for this has changed over time). If none exists: `pg_dump` the Postgres data as a snapshot, then wind the project down to stop the charge. **Do not delete without the snapshot** |
| **`quantumtx.com` DNS** | Domain + the DNS records email verification needs | Nothing further — `[DNS_OWNER]` already has access from the grant above |

## Key swaps (no transfer path exists — company accounts + new keys)

**Do these while the owner is still reachable** — the swap itself doesn't need them, but
the final revocation of the old key does (see "Before the owner leaves" above).

| Service | Used by | The swap |
|---|---|---|
| **Anthropic** | Legacy DLMS invoice extraction (live, billing the personal key per use); platform env carries the same key | Team creates a company Anthropic console account → new key → set in Vercel env (both projects) → confirm it works → **owner revokes the personal key** |
| **Resend** | Platform email (currently unset — email no-ops) and legacy edge-function alerts | Company Resend account → verify `quantumtx.com` (DNS!) → key into Vercel env + Supabase edge-function secrets → confirm it works → **owner revokes old key** |
| **Voyage** | Parked clinical stack only | Swap only if the clinical stack is revived — not urgent, but still needs the owner's revocation step whenever it happens |

## Day one after access — two things to know before inviting users

1. **The platform's Super Admin console can invite users, but the invited-user
   set-password path is unverified and probably a dead end** (the app has no
   set-password page; details in the engineering handover's known-issues list).
   Until that's fixed or verified, onboard admins the way that is proven to work:
   Supabase dashboard → Authentication → **Add user** (email + password,
   auto-confirm) after an admin has created the matching platform user — first
   login links the two automatically.
2. **The current bootstrap Super Admin is the owner's personal email.** Once the
   team's own Super Admin exists and has signed in, deactivate the bootstrap
   account from the console (do not delete it — audit history references it).

## Secrets

Credentials are **not in this file and not in git**. The owner holds a local vault-ready file
with every secret pre-filled for password-manager import; it travels only through the
credential channel. On import: delete the source file and **rotate the ops database
password** (it transited a chat transcript during setup).

## Current billing state (verified 2026-08-05)

- Vercel: **Hobby (free)** — the deploy is parked precisely because Hobby rejects the 5-minute cron; the upgrade decision belongs to `[VERCEL_TEAM]`, not the personal account.
- Supabase: **Free tier**, both active projects. Consequence: the ops project auto-pauses after ~a week idle (un-pause is a dashboard button); no point-in-time recovery until Pro.
- Railway: personal workspace, parked clinical stack — the one likely recurring charge; see its row above.
- Anthropic: personal key pays for legacy invoice extraction per use — swap early, while the owner can still revoke the old one.
- GitHub / Resend / Voyage: no charges today.
