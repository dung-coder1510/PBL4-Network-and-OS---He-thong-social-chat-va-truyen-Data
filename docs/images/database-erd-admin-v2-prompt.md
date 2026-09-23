# Prompt tạo sơ đồ database

Công cụ: built-in ImageGen (chỉnh ảnh tham chiếu).
Nguồn dữ liệu: mục 3 «Sơ đồ quan hệ» của `docs/database-design-admin.md`.
Kết quả: `database-erd-admin-v2.png`.

```text
Use case: infographic-diagram, precise redraw of the attached edit target.
Create a beautiful, highly legible database relationship diagram in Vietnamese for a university PBL4 project. Redesign the attached tangled monochrome ER diagram into a polished flat vector-style technical infographic. The source of truth is section 3 of the user's database design document, transcribed below. Preserve the database semantics exactly. This is an image asset for the user's report, not a website. Landscape approximately 2400 x 1700 or larger, crisp dark typography, generous padding, near-white background, clean rounded table cards, subtle shadows, restrained blue / teal / violet / amber accents. Absolutely no decorative 3D, perspective, gradients behind text, random icons, watermark, clipped labels, overlapping edges or crossing-through-card lines.

Exact title: "PBL4 — SƠ ĐỒ QUAN HỆ DATABASE"
Exact subtitle: "7 bảng • Chat 1–1 • Admin và nhật ký quản trị"

LAYOUT: one Users card at the top center. A middle row of three spacious cards: Contacts on the left, DirectConversations at center, AdminAuditLogs on the right. A bottom row of three spacious cards: Messages on the left, FileTransfers in the middle, Calls on the right. Clear top-to-bottom hierarchy. User card blue header, Contacts teal, DirectConversations violet, AdminAuditLogs amber, bottom cards restrained distinct blue-violet accents. English table identifiers in large bold sans-serif and Vietnamese descriptions smaller. Make every field legible when zoomed. All seven table names exactly once, no duplicate table cards.

TABLE CONTENT, exact labels; PK/FK as small colored badges, followed by exact field identifiers:
Users
subtitle "Tài khoản"
"PK  Id"

Contacts
subtitle "Danh bạ một chiều"
"PK, FK  UserId → Users.Id"
"PK, FK  ContactUserId → Users.Id"

DirectConversations
subtitle "Cuộc trò chuyện 1–1"
"PK  Id"
"FK  UserAID → Users.Id"
"FK  UserBID → Users.Id"

AdminAuditLogs
subtitle "Nhật ký quản trị"
"PK  Id"
"FK  AdminUserId → Users.Id"
"FK  TargetUserId → Users.Id"

Messages
subtitle "Tin nhắn"
"PK  Id"
"FK  ConversationId → DirectConversations.Id"
"FK  SenderId → Users.Id"

FileTransfers
subtitle "Truyền file"
"PK  Id"
"FK  ConversationId → DirectConversations.Id"
"FK  SenderId → Users.Id"

Calls
subtitle "Gọi thoại"
"PK  Id"
"FK  ConversationId → DirectConversations.Id"
"FK  CallerId → Users.Id"

CONNECTORS FOR READABILITY:
Draw orderly orthogonal connectors in the whitespace. Three connectors from Users to the three middle cards. Each such connector represents TWO SEPARATE one-to-many foreign-key relationships, never a composite FK: its separate field references are clearly listed inside the destination card. Label each of these connectors "2 FK riêng".
Draw three violet connectors from DirectConversations down to Messages, FileTransfers and Calls, each labeled "ConversationId", with "1" near the parent side and "0..N" near the child side. Route the branching connectors below the middle row; do not intersect cards or text.
To avoid the original spaghetti of long edges, DO NOT draw long Users-to-bottom-row lines: the three exact "SenderId → Users.Id"/"CallerId → Users.Id" field rows explicitly encode those remaining relationships. These field rows must be visible and must not be omitted. This is an intentionally simplified overview; the legend explicitly explains that FK references are authoritative.

Exact bottom legend, in a spacious full-width light-tinted strip:
"PK: khóa chính     FK: khóa ngoại     1 → 0..N: một — không hoặc nhiều"
"Mỗi cột FK là một tham chiếu riêng. Các FK đến Users được ghi ngay trong bảng để giảm đường nối."

SOURCE OF TRUTH, all TWELVE individual relationships must be represented by the cards' exact FK rows:
Users.Id -> Contacts.UserId
Users.Id -> Contacts.ContactUserId
Users.Id -> DirectConversations.UserAID
Users.Id -> DirectConversations.UserBID
DirectConversations.Id -> Messages.ConversationId
DirectConversations.Id -> FileTransfers.ConversationId
DirectConversations.Id -> Calls.ConversationId
Users.Id -> Messages.SenderId
Users.Id -> FileTransfers.SenderId
Users.Id -> Calls.CallerId
Users.Id -> AdminAuditLogs.AdminUserId
Users.Id -> AdminAuditLogs.TargetUserId
Each parent is exactly one and can have zero or many children through each FK.
Do not invent direct relationships between Contacts and Messages, AdminAuditLogs and DirectConversations, or the three bottom tables. Do not show data transfer arrows between tables as if this were a networking architecture diagram. It is a schema relationship overview.
```
