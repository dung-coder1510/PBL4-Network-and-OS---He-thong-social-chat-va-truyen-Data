using System.Globalization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;

namespace PBL4.Services;

public sealed record SavedReceipt(MessageStatusDto Status, int SenderUserId);

public sealed class MessageReceiptService(AppDbContext db)
{
    public async Task<SavedReceipt> SaveAsync(int recipientUserId,
        MessageReceiptRequestDto request, bool markRead, CancellationToken ct)
    {
        if (!long.TryParse(request.ConversationId, NumberStyles.None,
                CultureInfo.InvariantCulture, out var conversationId) || conversationId <= 0 ||
            !long.TryParse(request.UpToMessageId, NumberStyles.None,
                CultureInfo.InvariantCulture, out var upToMessageId) || upToMessageId <= 0)
            throw new HubException("Thông tin xác nhận tin nhắn không hợp lệ.");

        var conversation = await db.DirectConversations.AsNoTracking()
            .Where(c => c.Id == conversationId &&
                (c.UserAID == recipientUserId || c.UserBID == recipientUserId))
            .Select(c => new { c.UserAID, c.UserBID })
            .SingleOrDefaultAsync(ct);
        if (conversation is null)
            throw new HubException("Không tìm thấy cuộc trò chuyện.");

        var senderUserId = conversation.UserAID == recipientUserId
            ? conversation.UserBID : conversation.UserAID;
        var validBoundary = await db.Messages.AsNoTracking().AnyAsync(m =>
            m.Id == upToMessageId && m.ConversationId == conversationId &&
            m.SenderId == senderUserId, ct);
        if (!validBoundary)
            throw new HubException("Mốc xác nhận tin nhắn không hợp lệ.");

        var now = DateTime.UtcNow;
        var messages = db.Messages.Where(m => m.ConversationId == conversationId &&
            m.SenderId == senderUserId && m.Id <= upToMessageId);
        if (markRead)
        {
            await messages.Where(m => m.DeliveredAt == null || m.ReadAt == null)
                .ExecuteUpdateAsync(setters => setters
                    .SetProperty(m => m.DeliveredAt, m => m.DeliveredAt ?? now)
                    .SetProperty(m => m.ReadAt, m => m.ReadAt ?? now), ct);
        }
        else
        {
            await messages.Where(m => m.DeliveredAt == null)
                .ExecuteUpdateAsync(setters => setters.SetProperty(m => m.DeliveredAt, now), ct);
        }

        return new SavedReceipt(new MessageStatusDto(
            conversationId.ToString(CultureInfo.InvariantCulture),
            upToMessageId.ToString(CultureInfo.InvariantCulture), recipientUserId,
            now, markRead ? now : null), senderUserId);
    }
}
