using System.Globalization;
using System.Security.Claims;
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
    TypingRateLimiter typingLimiter, IOptions<HeartbeatOptions> heartbeatOptions) : Hub<IChatClient>
{
    private int CurrentUserId => int.Parse(Context.User!.FindFirstValue("sub")!,
        CultureInfo.InvariantCulture);

    public async Task<MessageDto> SendMessage(SendMessageDto request)
    {
        var senderId = CurrentUserId;
        var saved = await messages.SaveAsync(senderId, request, Context.ConnectionAborted);

        // Phát cả các tab của người gửi và người nhận. Frontend upsert theo ClientMessageId.
        var connectionIds = presence.GetValidConnectionIds([senderId, saved.PeerUserId]);
        if (connectionIds.Count > 0)
            await Clients.Clients(connectionIds).MessageReceived(saved.Message);
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

    public async Task<HeartbeatAckDto> Heartbeat()
    {
        await presenceService.RecordHeartbeatAsync(CurrentUserId, Context.ConnectionId,
            Context.ConnectionAborted);
        return new HeartbeatAckDto(heartbeatOptions.Value.IntervalSeconds);
    }

    public override async Task OnConnectedAsync()
    {
        var userId = CurrentUserId;
        var sessionId = Context.User!.FindFirstValue("sid")!;
        presence.Connect(userId, sessionId, Context.ConnectionId);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var userId = CurrentUserId;
        presence.Disconnect(userId, Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    private Task NotifyReceipt(SavedReceipt saved)
    {
        var connectionIds = presence.GetValidConnectionIds([
            saved.SenderUserId, saved.Status.RecipientUserId
        ]);
        return connectionIds.Count == 0 ? Task.CompletedTask
            : Clients.Clients(connectionIds).MessageStatusChanged(saved.Status);
    }

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
