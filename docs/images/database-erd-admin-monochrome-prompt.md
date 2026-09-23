# Prompt sơ đồ đen trắng

Công cụ: built-in ImageGen, chỉnh từ database-erd-admin-v2.png.

```text
Edit this database diagram into a plain black-and-white academic ER diagram for a student report. The user explicitly dislikes colorful or decorative styling.

Change ONLY visual styling. Preserve the exact seven tables, all table/field names, Vietnamese text, all twelve foreign-key references, and the existing clear top-to-bottom arrangement and connector meanings. Users is top center; Contacts, DirectConversations, AdminAuditLogs are the middle row; Messages, FileTransfers, Calls are the bottom row.

Required appearance: completely solid white background, black text, thin black straight orthogonal connectors, thin black rectangular table borders with square corners, bold simple Arial-like table headings, normal-weight field rows. Flat technical drawing. Remove ALL blue, teal, purple, orange, colored fills, gradients, shadows, glowing borders, pill badges, decorative backgrounds and rounded panels. No illustrations or decorative icons. PK and FK are plain black text labels, not colored badges. Connector labels are simple black text on white space. Make it look like a clean diagram prepared in draw.io for a university report. Keep generous spacing, crisp large legible text and balanced alignment. Landscape high-resolution output.

Keep these exact tables and key rows:
Users: PK Id.
Contacts: PK, FK UserId → Users.Id; PK, FK ContactUserId → Users.Id.
DirectConversations: PK Id; FK UserAID → Users.Id; FK UserBID → Users.Id.
AdminAuditLogs: PK Id; FK AdminUserId → Users.Id; FK TargetUserId → Users.Id.
Messages: PK Id; FK ConversationId → DirectConversations.Id; FK SenderId → Users.Id.
FileTransfers: PK Id; FK ConversationId → DirectConversations.Id; FK SenderId → Users.Id.
Calls: PK Id; FK ConversationId → DirectConversations.Id; FK CallerId → Users.Id.

Retain three Users-to-middle connectors each labeled "2 FK riêng". Retain three DirectConversations-to-bottom connectors each labeled "ConversationId", "1" at parent side, "0..N" at child side. User references from the bottom row remain explicit in their field rows so that long crossing lines are unnecessary. Do not invent any new relationship. No crossed lines, overlapping labels, clipped text or changed identifiers.

Title in modest bold black type: "SƠ ĐỒ QUAN HỆ DATABASE — PBL4".
Retain a plain text legend at the bottom without a colored container:
"PK: khóa chính    FK: khóa ngoại    1 → 0..N: một — không hoặc nhiều"
"Mỗi cột FK là một tham chiếu riêng. Các FK đến Users được ghi ngay trong bảng để giảm đường nối."
```
