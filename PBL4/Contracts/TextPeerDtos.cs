namespace PBL4.Contracts;

// Mo ta phien va cap tai khoan/tab: A tao offer, B tra answer; ID SQL giu dang chuoi.
public sealed record TextPeerSessionDto(string SessionId, string ConversationId,
    int UserAId, int UserBId, string ConnectionAId, string ConnectionBId);
// Goi bao hieu offer/answer/ice; payload khong chua noi dung tin nhan.
public sealed record TextSignalDto(string SessionId, string Kind, string Payload);
// Bao dong dung phien de client bo peer va tai bu tin da commit neu can.
public sealed record TextSessionClosedDto(string SessionId, string ConversationId);
// Yeu cau luu tin P2P kem phien dung de kiem tra endpoint truoc khi ghi SQL.
public sealed record CommitPeerMessageDto(string SessionId, SendMessageDto Message);
// Tham chieu ban da luu de fallback; giu ClientMessageId cu de tranh insert trung.
public sealed record CommittedMessageReferenceDto(string ConversationId, Guid ClientMessageId);
// ACK/read cho mot tin duy nhat, khac voi UpToMessageId cong don cua client cu.
public sealed record ExactMessageReceiptDto(string ConversationId, string MessageId);
// Bang chung receipt: rang buoc phien, hai ID tin va hash noi dung peer thuc su nhan.
public sealed record PeerMessageReceiptDto(string SessionId, string MessageId,
    Guid ClientMessageId, string ContentSha256Hex);
// Tra receipt va thoi gian goc SQL de client khong tin timestamp do peer tu nhan.
public sealed record PeerMessageAcknowledgementDto(MessageStatusDto Status, DateTime CreatedAt);
