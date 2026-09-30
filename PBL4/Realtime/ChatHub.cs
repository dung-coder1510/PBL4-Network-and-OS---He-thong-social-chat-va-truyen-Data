using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Services;

namespace PBL4.Realtime;

[Authorize]
public sealed class ChatHub(MessageService messages, MessageReceiptService receipts,
    AppDbContext db, PresenceTracker presence, TypingRateLimiter typingLimiter) : Hub<IChatClient>
{
    private int CurrentUserId => int.Parse(Context.User!.FindFirstValue("sub")!,
        CultureInfo.InvariantCulture);

    public async Task<MessageDto> SendMessage(SendMessageDto request)
    {
        var senderId = CurrentUserId;
        var saved = await messages.SaveAsync(senderId, request, Context.ConnectionAborted);

        // Phát cả các tab của người gửi và người nhận. Frontend upsert theo ClientMessageId.
        await Clients.Users([
            senderId.ToString(CultureInfo.InvariantCulture),
            saved.PeerUserId.ToString(CultureInfo.InvariantCulture)
        ]).MessageReceived(saved.Message);
        return saved.Message;
    }

    public async Task AcknowledgeDelivered(MessageReceiptRequestDto request)
    {
        var saved = await receipts.SaveAsync(CurrentUserId, request, false,
            Context.ConnectionAborted);
        await NotifyReceipt(saved);
    }

    public async Task MarkAsRead(MessageReceiptRequestDto request)
    {
        var saved = await receipts.SaveAsync(CurrentUserId, request, true,
            Context.ConnectionAborted);
        await NotifyReceipt(saved);
    }

    public Task StartTyping(TypingRequestDto request) => SetTyping(request, true);

    public Task StopTyping(TypingRequestDto request) => SetTyping(request, false);

    public override async Task OnConnectedAsync()
    {
        var userId = CurrentUserId;
        if (presence.Connect(userId, Context.ConnectionId))
            await NotifyPresence(userId, true, null, Context.ConnectionAborted);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var userId = CurrentUserId;
        if (presence.Disconnect(userId, Context.ConnectionId))
        {
            var lastSeenAt = DateTime.UtcNow;
            await db.Users.Where(u => u.Id == userId)
                .ExecuteUpdateAsync(setters => setters.SetProperty(u => u.LastSeenAt, lastSeenAt));
            await NotifyPresence(userId, false, lastSeenAt, CancellationToken.None);
        }
        await base.OnDisconnectedAsync(exception);
    }

    private Task NotifyReceipt(SavedReceipt saved) => Clients.Users([
        saved.SenderUserId.ToString(CultureInfo.InvariantCulture),
        saved.Status.RecipientUserId.ToString(CultureInfo.InvariantCulture)
    ]).MessageStatusChanged(saved.Status);

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
        await Clients.User(peerId.ToString(CultureInfo.InvariantCulture))
            .TypingChanged(new TypingStateDto(request.ConversationId, userId, isTyping));
    }

    private async Task NotifyPresence(int userId, bool isOnline, DateTime? lastSeenAt,
        CancellationToken ct)
    {
        var peers = await db.DirectConversations.AsNoTracking()
            .Where(c => c.UserAID == userId || c.UserBID == userId)
            .Select(c => c.UserAID == userId ? c.UserBID : c.UserAID)
            .Concat(db.Contacts.AsNoTracking().Where(c => c.UserId == userId)
                .Select(c => c.ContactUserId))
            .Concat(db.Contacts.AsNoTracking().Where(c => c.ContactUserId == userId)
                .Select(c => c.UserId))
            .Distinct().ToListAsync(ct);
        peers.Add(userId);
        await Clients.Users(peers.Distinct().Select(id =>
                id.ToString(CultureInfo.InvariantCulture)).ToArray())
            .PresenceChanged(new PresenceDto(userId, isOnline, lastSeenAt));
    }
}
