namespace PBL4.Contracts;

public sealed record FileObservationDto(string TransferId, string Stage, long? Bytes, string? Reason);

public sealed record OfferFileDto(string ConversationId, Guid ClientTransferId,
    string FileName, long FileSizeBytes, string? Sha256Hex,
    string[]? SupportedProtocols = null, int RequestedChannelCount = 1,
    string? RelayMode = null, int RelayConnectionCount = 1, bool AllowTurn = false);
public sealed record FileActionDto(string TransferId, string ExpectedVersion, string? FailureCode = null,
    string? ProtocolVersion = null, int ChannelCount = 1, bool AllowTurn = false);
public sealed record FinalizeFileHashDto(string TransferId, string ExpectedVersion, string Sha256Hex);
public sealed record CompleteFileDto(string TransferId, string ExpectedVersion,
    long ReceivedBytes, string VerifiedSha256Hex);
public sealed record FileSignalDto(string TransferId, string Kind, string Payload, int ConnectionIndex = 0);
public sealed record FileRelayAcceptanceDto(FileTransferDto Transfer, string ReceiverKey);
public sealed record FileRelayContent(long Size, string Sha256Hex);
public sealed record PrepareFileRelayDto(string Sha256Hex, int ConnectionCount);
public sealed record RelaySenderSessionDto(string SenderKey, string RelayMode, int PartBytes, int ConnectionCount);
public sealed record RelayHashDto(string Sha256Hex);
public sealed record AckRelayPartsDto(int[] PartIndices);
public sealed record FileTransferDto(string Id, Guid ClientTransferId, string ConversationId,
    int SenderId, int ReceiverId, string FileName, long FileSizeBytes, string? Sha256Hex,
    string? VerifiedSha256Hex, string Status, DateTime CreatedAt, DateTime? AcceptedAt,
    DateTime? FinishedAt, string Version, string? SenderConnectionId, string? ReceiverConnectionId,
    string[]? SupportedProtocols = null, string? ProtocolVersion = null, int ChannelCount = 1,
    int RequestedChannelCount = 1, string? Transport = null, bool RelayReady = false, long RelayedBytes = 0,
    int RelayConnectionCount = 1, string? RelayMode = null, int? RelayPartBytes = null, bool AllowTurn = false);
public sealed record FilePageDto(IReadOnlyList<FileTransferDto> Items, string? NextCursor);
