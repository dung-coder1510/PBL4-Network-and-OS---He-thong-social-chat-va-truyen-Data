using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Services;

namespace PBL4.Realtime;

[Authorize]
public sealed class ChatHub(MessageService messages, MessageReceiptService receipts,
    AppDbContext db, PresenceTracker presence, PresenceService presenceService,
    TypingRateLimiter typingLimiter, IOptions<HeartbeatOptions> heartbeatOptions,
    FileTransferService files, TextPeerSessionService textPeers) : Hub<IChatClient>
{
    // Lay danh tinh tu JWT da xac thuc, khong tin SenderId do client tu khai bao.
    private int CurrentUserId => int.Parse(Context.User!.FindFirstValue("sub")!,
        CultureInfo.InvariantCulture);

    // Luu SQL va giao tin qua SignalR cho cac tab cua hai tai khoan; tra tin da luu cho caller.
    // Day la duong gui mac dinh khi DataChannel chua san sang.
    public async Task<MessageDto> SendMessage(SendMessageDto request)
    {
        var senderId = CurrentUserId;
        var saved = await messages.SaveAsync(senderId, request, Context.ConnectionAborted);

        // Phat ca cac tab; frontend gop theo ClientMessageId de khong tao bong tin trung.
        var connectionIds = presence.GetValidConnectionIds([senderId, saved.PeerUserId]);
        if (connectionIds.Count > 0)
            await Clients.Clients(connectionIds).MessageReceived(saved.Message);
        return saved.Message;
    }

    // Nhan ACK cong don tu client cu va phat receipt, khong tu danh dau da doc.
    public async Task AcknowledgeDelivered(MessageReceiptRequestDto request)
    {
        var saved = await receipts.SaveAsync(CurrentUserId, request, false,
            Context.ConnectionAborted);
        await NotifyReceipt(saved);
    }

    // Giu lenh doc cong don cua client cu; dong thoi dam bao cac tin nay da nhan.
    public async Task MarkAsRead(MessageReceiptRequestDto request)
    {
        var saved = await receipts.SaveAsync(CurrentUserId, request, true,
            Context.ConnectionAborted);
        await NotifyReceipt(saved);
    }

    // Bao cho peer biet caller dang nhap; noi dung ban nhap khong duoc gui hoac luu.
    public Task StartTyping(TypingRequestDto request) => SetTyping(request, true);

    // Tat trang thai dang nhap cua caller trong conversation.
    public Task StopTyping(TypingRequestDto request) => SetTyping(request, false);

    // Nho registry chon tab nhan va tao/lay phien; null nghia la client nen dung SignalR.
    public Task<TextPeerSessionDto?> StartTextSession(string conversationId) =>
        textPeers.StartAsync(CurrentUserId, Context.ConnectionId, conversationId, Context.ConnectionAborted);

    // Chuyen SDP/ICE cua text qua server, chi toi endpoint da rang buoc trong phien.
    public Task SendTextSignal(TextSignalDto request) =>
        textPeers.SignalAsync(CurrentUserId, Context.ConnectionId, request);

    // Nhan thong bao DataChannel cua tab hien tai da mo; ca hai tab phai ready moi commit P2P.
    public Task TextSessionReady(string sessionId) =>
        textPeers.ReadyAsync(CurrentUserId, Context.ConnectionId, sessionId);

    // Ket thuc phien text cua dung endpoint va thong bao cho ca hai dau.
    public Task CloseTextSession(string sessionId) =>
        textPeers.CloseAsync(CurrentUserId, Context.ConnectionId, sessionId);

    // Luu tin truoc khi caller gui P2P; chi dong bo cac tab phu va tra DTO chuan cho tab gui.
    // Loai tab nhan P2P khoi fan-out de payload khong den qua SignalR truoc DataChannel.
    public async Task<MessageDto> CommitPeerMessage(CommitPeerMessageDto request)
    {
        var session = await textPeers.RequireAsync(CurrentUserId, Context.ConnectionId, request.SessionId, true);
        if (request.Message is null || request.Message.ConversationId != session.ConversationId)
            throw new HubException("TEXT_INVALID_CONVERSATION");
        var saved = await messages.SaveAsync(CurrentUserId, request.Message, Context.ConnectionAborted);
        var target = Context.ConnectionId == session.ConnectionAId ? session.ConnectionBId : session.ConnectionAId;
        var others = presence.GetValidConnectionIds([CurrentUserId, saved.PeerUserId])
            .Where(id => id != target && id != Context.ConnectionId).ToArray();
        if (others.Length > 0) await Clients.Clients(others).MessageReceived(saved.Message);
        return saved.Message;
    }

    // Giao lai tin da commit khi P2P loi/het cho ACK; tra ban ghi cu, khong insert tin moi.
    // Chi caller da gui tin moi duoc yeu cau relay UUID do.
    public async Task<MessageDto> RelayCommittedMessage(CommittedMessageReferenceDto request)
    {
        if (!long.TryParse(request.ConversationId, NumberStyles.None, CultureInfo.InvariantCulture,
                out var id) || id <= 0 || request.ClientMessageId == Guid.Empty)
            throw new HubException("TEXT_INVALID_MESSAGE");
        var message = await db.Messages.AsNoTracking().SingleOrDefaultAsync(m =>
            m.ConversationId == id && m.ClientMessageId == request.ClientMessageId &&
            m.SenderId == CurrentUserId &&
            ((m.Conversation.UserAID == CurrentUserId && !m.Conversation.UserB.IsDisabled) ||
             (m.Conversation.UserBID == CurrentUserId && !m.Conversation.UserA.IsDisabled)), Context.ConnectionAborted);
        if (message is null) throw new HubException("TEXT_MESSAGE_NOT_FOUND");
        var peerId = await db.DirectConversations.Where(c => c.Id == id)
            .Select(c => c.UserAID == CurrentUserId ? c.UserBID : c.UserAID).SingleAsync(Context.ConnectionAborted);
        var dto = MessageService.ToDto(message);
        var ids = presence.GetValidConnectionIds([CurrentUserId, peerId]);
        if (ids.Count > 0) await Clients.Clients(ids).MessageReceived(dto);
        return dto;
    }

    // Xac minh tin peer vua nhan khop ban SQL, ghi ACK rieng le va tra receipt/thoi gian goc.
    public async Task<PeerMessageAcknowledgementDto> AcknowledgePeerMessage(PeerMessageReceiptDto request)
    {
        var session = await textPeers.RequireAsync(CurrentUserId, Context.ConnectionId, request.SessionId);
        if (!long.TryParse(request.MessageId, NumberStyles.None, CultureInfo.InvariantCulture,
                out var id) || id <= 0 || request.ClientMessageId == Guid.Empty ||
            request.ContentSha256Hex?.Length != 64)
            throw new HubException("TEXT_INVALID_MESSAGE");
        var senderId = CurrentUserId == session.UserAId ? session.UserBId : session.UserAId;
        var conversationId = long.Parse(session.ConversationId, CultureInfo.InvariantCulture);
        var message = await db.Messages.AsNoTracking().SingleOrDefaultAsync(m => m.Id == id &&
            m.ConversationId == conversationId && m.SenderId == senderId && !m.Sender.IsDisabled &&
            m.ClientMessageId == request.ClientMessageId, Context.ConnectionAborted);
        // Bam UTF-8 bang SHA-256 de doi chieu noi dung; hash khong thay the ma hoa dau cuoi.
        // Sender va conversation duoc suy tu phien, khong lay theo danh tinh client tu khai.
        if (message is null || !string.Equals(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(message.Content))),
                request.ContentSha256Hex, StringComparison.OrdinalIgnoreCase))
            throw new HubException("TEXT_MESSAGE_MISMATCH");
        var saved = await receipts.SaveOneAsync(CurrentUserId,
            new ExactMessageReceiptDto(session.ConversationId, request.MessageId), false, Context.ConnectionAborted);
        await NotifyReceipt(saved);
        return new PeerMessageAcknowledgementDto(saved.Status,
            DateTime.SpecifyKind(message.CreatedAt, DateTimeKind.Utc));
    }

    // Ghi da nhan dung mot tin SignalR/tai bu; tra receipt de client gop trang thai nhat quan.
    public async Task<MessageStatusDto> AcknowledgeMessage(ExactMessageReceiptDto request)
    {
        var saved = await receipts.SaveOneAsync(CurrentUserId, request, false, Context.ConnectionAborted);
        await NotifyReceipt(saved);
        return saved.Status;
    }

    // Ghi da doc dung mot MessageId va tra so unread con lai, khong doc vuot cac tin bi thieu.
    public async Task<MessageStatusDto> ReadMessage(ExactMessageReceiptDto request)
    {
        var saved = await receipts.SaveOneAsync(CurrentUserId, request, true, Context.ConnectionAborted);
        await NotifyReceipt(saved);
        return saved.Status;
    }

    // Tao loi moi gui file va luu metadata; byte file di qua WebRTC rieng voi text.
    public Task<FileTransferDto> OfferFile(OfferFileDto request) =>
        files.OfferAsync(CurrentUserId, Context.ConnectionId, request);
    // Rang buoc tab nhan chap nhan loi moi; service kiem tra quyen va RowVersion.
    public Task<FileTransferDto> AcceptFile(FileActionDto request) =>
        files.ActAsync(CurrentUserId, Context.ConnectionId, request, "accept");
    // Ghi quyet dinh tu choi cua nguoi nhan va thong bao trang thai file.
    public Task<FileTransferDto> RejectFile(FileActionDto request) =>
        files.ActAsync(CurrentUserId, Context.ConnectionId, request, "reject");
    // Chuyen file sang transferring khi tab gui bao DataChannel file da mo.
    public Task<FileTransferDto> BeginFileTransfer(FileActionDto request) =>
        files.ActAsync(CurrentUserId, Context.ConnectionId, request, "begin");
    // Huy phien file theo yeu cau mot trong hai endpoint hop le.
    public Task<FileTransferDto> CancelFile(FileActionDto request) =>
        files.ActAsync(CurrentUserId, Context.ConnectionId, request, "cancel");
    // Danh dau phien file that bai khi endpoint bao loi ket noi, protocol hoac du lieu.
    public Task<FileTransferDto> FailFile(FileActionDto request) =>
        files.ActAsync(CurrentUserId, Context.ConnectionId, request, "fail");
    // Nhan so byte/hash nguoi nhan da kiem tra va chuyen phien file sang completed neu hop le.
    public Task<FileTransferDto> CompleteFile(CompleteFileDto request) =>
        files.ActAsync(CurrentUserId, Context.ConnectionId,
            new FileActionDto(request.TransferId, request.ExpectedVersion), "complete", request);
    // Chuyen SDP/ICE cua file qua service file; khong dung registry phien text.
    public Task SendFileSignal(FileSignalDto request) =>
        files.SignalAsync(CurrentUserId, Context.ConnectionId, request);

    // Ghi nhip song ung dung va tra chu ky server de client len lich lan gui tiep theo.
    public async Task<HeartbeatAckDto> Heartbeat()
    {
        await presenceService.RecordHeartbeatAsync(CurrentUserId, Context.ConnectionId,
            Context.ConnectionAborted);
        return new HeartbeatAckDto(heartbeatOptions.Value.IntervalSeconds);
    }

    // Dang ky socket voi tai khoan/phien JWT; online chi duoc xac nhan khi co heartbeat.
    public override async Task OnConnectedAsync()
    {
        var userId = CurrentUserId;
        var sessionId = Context.User!.FindFirstValue("sid")!;
        presence.Connect(userId, sessionId, Context.ConnectionId);
        await base.OnConnectedAsync();
    }

    // Bo ket noi khoi presence va don cac phien text/file co endpoint vua ngat.
    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var userId = CurrentUserId;
        presence.Disconnect(userId, Context.ConnectionId);
        await textPeers.SweepAsync(Context.ConnectionId);
        await files.SweepAsync(Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    // Phat receipt toi cac ket noi con hop le cua sender va recipient, gom ca tab phu.
    private Task NotifyReceipt(SavedReceipt saved)
    {
        var connectionIds = presence.GetValidConnectionIds([
            saved.SenderUserId, saved.Status.RecipientUserId
        ]);
        return connectionIds.Count == 0 ? Task.CompletedTask
            : Clients.Clients(connectionIds).MessageStatusChanged(saved.Status);
    }

    // Kiem tra thanh vien, gioi han nhip bat typing va chi phat den peer cua conversation.
    // Typing chi la trang thai tam, khong ghi thanh tin nhan SQL.
    private async Task SetTyping(TypingRequestDto request, bool isTyping)
    {
        if (!long.TryParse(request.ConversationId, NumberStyles.None,
                CultureInfo.InvariantCulture, out var conversationId) || conversationId <= 0)
            throw new HubException("Cuộc trò chuyện không hợp lệ.");
        var userId = CurrentUserId;
        var peerId = await db.DirectConversations.AsNoTracking()
            .Where(c => c.Id == conversationId &&
                (c.UserAID == userId || c.UserBID == userId))
            .Select(c => c.UserAID == userId ? c.UserBID : c.UserAID)
            .SingleOrDefaultAsync(Context.ConnectionAborted);
        if (peerId == 0) throw new HubException("Không tìm thấy cuộc trò chuyện.");
        if (isTyping && !typingLimiter.AllowStart(userId, conversationId)) return;
        if (!isTyping) typingLimiter.Stop(userId, conversationId);
        var connectionIds = presence.GetValidConnectionIds([peerId]);
        if (connectionIds.Count > 0)
            await Clients.Clients(connectionIds)
                .TypingChanged(new TypingStateDto(request.ConversationId, userId, isTyping));
    }
}
