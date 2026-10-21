using System.Globalization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;

namespace PBL4.Services;

public sealed record SavedReceipt(MessageStatusDto Status, int SenderUserId);

public sealed class MessageReceiptService(AppDbContext db)
{
    // Xac nhan da nhan/da doc dung mot MessageId; khong danh dau cac tin truoc con thieu.
    // Tra receipt hien tai va sender de Hub phat trang thai toi hai tai khoan.
    public async Task<SavedReceipt> SaveOneAsync(int recipientUserId,
        ExactMessageReceiptDto request, bool markRead, CancellationToken ct)
    {
        if (!long.TryParse(request.ConversationId, NumberStyles.None, CultureInfo.InvariantCulture,
                out var conversationId) || conversationId <= 0 ||
            !long.TryParse(request.MessageId, NumberStyles.None, CultureInfo.InvariantCulture,
                out var messageId) || messageId <= 0)
            throw new HubException("Thông tin xác nhận tin nhắn không hợp lệ.");
        var message = await db.Messages.AsNoTracking().Where(m => m.Id == messageId &&
                m.ConversationId == conversationId && m.SenderId != recipientUserId &&
                (m.Conversation.UserAID == recipientUserId || m.Conversation.UserBID == recipientUserId))
            .SingleOrDefaultAsync(ct);
        if (message is null) throw new HubException("Không tìm thấy tin nhắn.");
        var now = DateTime.UtcNow;
        var query = db.Messages.Where(m => m.Id == messageId);
        // Cap nhat tren SQL va chi dien timestamp con null de ACK lap khong doi thoi diem goc.
        // Da doc dong nghia da nhan, nhung da nhan khong tu dong thanh da doc.
        if (markRead)
            await query.ExecuteUpdateAsync(s => s
                .SetProperty(m => m.DeliveredAt, m => m.DeliveredAt ?? now)
                .SetProperty(m => m.ReadAt, m => m.ReadAt ?? now), ct);
        else
            await query.Where(m => m.DeliveredAt == null)
                .ExecuteUpdateAsync(s => s.SetProperty(m => m.DeliveredAt, now), ct);
        var current = await db.Messages.AsNoTracking().SingleAsync(m => m.Id == messageId, ct);
        var dto = MessageService.ToDto(current);
        // Dem lai so chua doc tren server; doc mot tin khong duoc xoa toan bo badge unread.
        int? unread = markRead ? await db.Messages.CountAsync(m => m.ConversationId == conversationId &&
            m.SenderId != recipientUserId && m.ReadAt == null, ct) : null;
        return new SavedReceipt(new MessageStatusDto(request.ConversationId, request.MessageId,
            recipientUserId, dto.DeliveredAt!.Value, dto.ReadAt, request.MessageId, unread), message.SenderId);
    }

    // Giu ACK/read cong don cho client cu: cap nhat tin tu peer co ID <= UpToMessageId.
    // Khong dung cach nay cho mot frame P2P rieng le vi co the bo qua khoang trong chua nhan.
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
        // Moc phai la tin do peer gui trong dung conversation, khong nhan ID bat ky tu client.
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

        var current = await db.Messages.AsNoTracking()
            .Where(m => m.Id == upToMessageId)
            .Select(m => new { m.DeliveredAt, m.ReadAt })
            .SingleAsync(ct);
        var deliveredAt = DateTime.SpecifyKind(current.DeliveredAt ?? now, DateTimeKind.Utc);
        DateTime? readAt = current.ReadAt.HasValue
            ? DateTime.SpecifyKind(current.ReadAt.Value, DateTimeKind.Utc) : null;
        return new SavedReceipt(new MessageStatusDto(
            conversationId.ToString(CultureInfo.InvariantCulture),
            upToMessageId.ToString(CultureInfo.InvariantCulture), recipientUserId,
            deliveredAt, readAt), senderUserId);
    }
}
