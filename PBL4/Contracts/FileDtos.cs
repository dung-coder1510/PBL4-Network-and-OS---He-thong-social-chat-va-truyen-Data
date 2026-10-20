namespace PBL4.Contracts;

public sealed record OfferFileDto(string ConversationId, Guid ClientTransferId,
    string FileName, long FileSizeBytes, string Sha256Hex);
public sealed record FileActionDto(string TransferId, string ExpectedVersion);
public sealed record CompleteFileDto(string TransferId, string ExpectedVersion,
    long ReceivedBytes, string VerifiedSha256Hex);
public sealed record FileSignalDto(string TransferId, string Kind, string Payload);
public sealed record FileTransferDto(string Id, Guid ClientTransferId, string ConversationId,
    int SenderId, int ReceiverId, string FileName, long FileSizeBytes, string Sha256Hex,
    string? VerifiedSha256Hex, string Status, DateTime CreatedAt, DateTime? AcceptedAt,
    DateTime? FinishedAt, string Version, string? SenderConnectionId, string? ReceiverConnectionId);
public sealed record FilePageDto(IReadOnlyList<FileTransferDto> Items, string? NextCursor);
