# Global Message

Global Message reuses tenant-scoped `Member`, `MemberMembership`, `MembershipPlan`, and successful `Payment` data. It does not create member records or send messages automatically.

## Click-to-Chat flow

Campaign recipients are opened one at a time through `https://wa.me/<mobile>?text=<encoded-message>`. A recipient is recorded as `WHATSAPP_OPENED` only after the owner opens the link. The owner must send the message in WhatsApp and then explicitly mark it sent in SS Fitness Manager. Opened chats are not treated as sent, and no delivery or read status is claimed.

## API

All endpoints require the existing authenticated owner session. Tenant and business scope come from the authenticated session, never from request data.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/global-messages/summary` | Tenant member total and most recently updated campaign |
| GET | `/api/global-messages/members` | Search/filter/paginate eligible members |
| POST | `/api/global-messages/campaigns` | Validate recipients and create a draft |
| GET | `/api/global-messages/campaigns` | Paginate campaign history |
| GET | `/api/global-messages/campaigns/:campaignId` | Campaign summary and paginated recipients |
| PATCH | `/api/global-messages/campaigns/:campaignId/status` | Start, pause, resume, or stop |
| PATCH | `/api/global-messages/campaigns/:campaignId/advance` | Move to the next processed recipient |
| PATCH | `/api/global-messages/campaigns/:campaignId/recipients/:memberId` | Record opened, manually sent, or skipped |

Member filters are `all`, `active`, `expired`, `expiringSoon` (within seven days), `pendingFees`, and `custom`. Campaigns support at most 3,000 recipients and messages up to 4,000 characters.

## Storage

The `globalmessagecampaigns` collection stores the message template, campaign state, tenant/business identifiers, current recipient, and recipient-level snapshots/status timestamps. Existing member and membership collections remain the source of truth when a campaign is created.

There are no new environment variables. MongoDB will create the campaign collection and indexes when the model is first used.

The eligibility aggregation uses MongoDB 5.0+ `$lookup` pipeline syntax. Existing MongoDB connectivity and deployment configuration are reused.
