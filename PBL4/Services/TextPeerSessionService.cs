using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Realtime;

namespace PBL4.Services;

// Quan ly phien text trong RAM cua mot backend; noi dung tin van nam trong SQL.
public sealed class TextPeerSessionService(IServiceScopeFactory scopes,
    IHubContext<ChatHub, IChatClient> hub, PresenceTracker presence, TimeProvider clock)
{
    // Khoa bat dong bo: hai yeu cau dong thoi khong duoc cung tao hoac sua mot phien.
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly Dictionary<string, Entry> active = [];
    // Luu tien trinh offer/answer, hai dau da san sang va so ICE da nhan cua tung dau.
    private sealed class Entry(TextPeerSessionDto session, DateTimeOffset deadline)
    {
        public TextPeerSessionDto Session { get; } = session;
        public DateTimeOffset Deadline { get; set; } = deadline;
        public bool Offered { get; set; }
        public bool Answered { get; set; }
        public HashSet<string> Ready { get; } = [];
        public Dictionary<string, int> Candidates { get; } = [];
    }

    // Tao hoac lay lai phien cua conversation cho dung tab dang goi.
    // Tra null neu chua co tab dich phu hop; client tiep tuc gui qua SignalR.
    public async Task<TextPeerSessionDto?> StartAsync(int userId, string connectionId,
        string conversationId, CancellationToken ct)
    {
        if (!long.TryParse(conversationId, NumberStyles.None, CultureInfo.InvariantCulture,
                out var id) || id <= 0) throw Error("INVALID_CONVERSATION");
        conversationId = id.ToString(CultureInfo.InvariantCulture);
        await gate.WaitAsync(ct);
        try
        {
            await SweepLockedAsync();
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var peerId = await db.DirectConversations.AsNoTracking()
                .Where(c => c.Id == id && (c.UserAID == userId || c.UserBID == userId))
                .Select(c => c.UserAID == userId ? c.UserBID : c.UserAID).SingleOrDefaultAsync(ct);
            if (peerId == 0 || !await db.Users.AnyAsync(u => u.Id == peerId && !u.IsDisabled, ct))
                throw Error("PEER_UNAVAILABLE");
            if (!presence.GetValidConnectionIds([userId]).Contains(connectionId))
                throw Error("SESSION_CLOSED");
            // Tai su dung phien trong cung khoa de hai ben cung mo chi nhan mot SessionId.
            var existing = active.Values.FirstOrDefault(e =>
                e.Session.ConversationId == conversationId &&
                (e.Session.ConnectionAId == connectionId || e.Session.ConnectionBId == connectionId));
            if (existing is not null) return existing.Session;
            // Sap xep ConnectionId de cach chon mot tab nhan luon nhat quan tren server.
            var target = presence.GetValidConnectionIds([peerId]).Order(StringComparer.Ordinal).FirstOrDefault();
            if (target is null) return null;
            // Tab phu khong duoc thay the cap tab da rang buoc; tab nay dung SignalR.
            if (active.Values.Any(e => e.Session.ConversationId == conversationId &&
                    (e.Session.ConnectionAId == target || e.Session.ConnectionBId == target))) return null;
            if (active.Count >= 1000 || Count(userId) >= 8 || Count(peerId) >= 8)
                throw Error("SESSION_LIMIT");
            var session = new TextPeerSessionDto(Guid.NewGuid().ToString("N"), conversationId,
                userId, peerId, connectionId, target);
            active.Add(session.SessionId, new Entry(session, clock.GetUtcNow().AddSeconds(15)));
            await hub.Clients.Clients([connectionId, target]).TextSessionStarted(session);
            return session;
        }
        finally { gate.Release(); }
    }

    // Dem phien co tai khoan tham gia o ca hai vai tro de ap dung gioi han tai nguyen.
    private int Count(int userId) => active.Values.Count(e =>
        e.Session.UserAId == userId || e.Session.UserBId == userId);

    // Kiem tra quyen cua tab, tuy chon yeu cau ca hai dau ready, roi gia han idle 20 phut.
    // Tra DTO phien hop le; nem HubException neu sai tab, het han hoac chua san sang.
    public async Task<TextPeerSessionDto> RequireAsync(int userId, string connectionId,
        string sessionId, bool ready = false)
    {
        await gate.WaitAsync();
        try
        {
            var entry = RequireLocked(userId, connectionId, sessionId);
            if (ready && entry.Ready.Count != 2) throw Error("PEER_NOT_READY");
            entry.Deadline = clock.GetUtcNow().AddMinutes(20);
            return entry.Session;
        }
        finally { gate.Release(); }
    }

    // Ghi nhan tab da mo DataChannel; chi chap nhan sau khi SDP answer da duoc chuyen.
    public async Task ReadyAsync(int userId, string connectionId, string sessionId)
    {
        await gate.WaitAsync();
        try
        {
            var entry = RequireLocked(userId, connectionId, sessionId);
            if (!entry.Answered) throw Error("INVALID_SIGNAL_STATE");
            entry.Ready.Add(connectionId);
            // HashSet loai bao ready lap; mot dau khong the tu gia han phien loi mai mai.
            if (entry.Ready.Count == 2) entry.Deadline = clock.GetUtcNow().AddMinutes(20);
        }
        finally { gate.Release(); }
    }

    // Kiem tra thu tu va kich thuoc offer/answer/ICE, roi chuyen toi tab con lai cua phien.
    // Gioi han so candidate tung dau de tranh tang bo nho va luu luong bao hieu vo han.
    public async Task SignalAsync(int userId, string connectionId, TextSignalDto signal)
    {
        await gate.WaitAsync();
        try
        {
            var entry = RequireLocked(userId, connectionId, signal.SessionId);
            var session = entry.Session;
            if (string.IsNullOrEmpty(signal.Payload)) throw Error("INVALID_SIGNAL");
            // Ben A chi gui mot offer; ben B chi tra mot answer sau offer, khong renegotiate.
            if (signal.Kind == "offer")
            {
                if (connectionId != session.ConnectionAId || entry.Offered || signal.Payload.Length > 24000)
                    throw Error("INVALID_SIGNAL");
                entry.Offered = true;
            }
            else if (signal.Kind == "answer")
            {
                if (connectionId != session.ConnectionBId || !entry.Offered || entry.Answered ||
                    signal.Payload.Length > 24000) throw Error("INVALID_SIGNAL");
                entry.Answered = true;
            }
            else if (signal.Kind == "ice")
            {
                if (signal.Payload.Length > 4096 || entry.Candidates.GetValueOrDefault(connectionId) >= 128)
                    throw Error("SIGNAL_LIMIT");
                try
                {
                    using var json = JsonDocument.Parse(signal.Payload);
                    if (json.RootElement.ValueKind != JsonValueKind.Object ||
                        !json.RootElement.TryGetProperty("candidate", out var candidate) ||
                        candidate.ValueKind != JsonValueKind.String) throw Error("INVALID_SIGNAL");
                }
                catch (JsonException) { throw Error("INVALID_SIGNAL"); }
                entry.Candidates[connectionId] = entry.Candidates.GetValueOrDefault(connectionId) + 1;
            }
            else throw Error("INVALID_SIGNAL");
            var target = connectionId == session.ConnectionAId ? session.ConnectionBId : session.ConnectionAId;
            await hub.Clients.Client(target).TextSignal(signal);
        }
        finally { gate.Release(); }
    }

    // Chi goi khi dang giu gate: kiem tra han, danh tinh tai khoan/tab va hai ket noi con hop le.
    // Biet SessionId chua du quyen gui signal; ConnectionId cung phai khop phien.
    private Entry RequireLocked(int userId, string connectionId, string sessionId)
    {
        if (string.IsNullOrEmpty(sessionId) || !active.TryGetValue(sessionId, out var entry) || entry.Deadline <= clock.GetUtcNow())
            throw Error("SESSION_CLOSED");
        var session = entry.Session;
        if (!((session.UserAId == userId && session.ConnectionAId == connectionId) ||
              (session.UserBId == userId && session.ConnectionBId == connectionId)))
            throw Error("WRONG_ENDPOINT");
        var valid = presence.GetValidConnectionIds([session.UserAId, session.UserBId]);
        if (!valid.Contains(session.ConnectionAId) || !valid.Contains(session.ConnectionBId))
            throw Error("SESSION_CLOSED");
        return entry;
    }

    // Dong phien cua dung tab; goi lap sau khi phien da bi xoa khong gay loi.
    public async Task CloseAsync(int userId, string connectionId, string sessionId)
    {
        await gate.WaitAsync();
        try
        {
            if (string.IsNullOrEmpty(sessionId) || !active.TryGetValue(sessionId, out var entry)) return;
            RequireLocked(userId, connectionId, sessionId);
            await RemoveLockedAsync(entry);
        }
        finally { gate.Release(); }
    }

    // Cong vao an toan cho worker hoac su kien mat ket noi; lay khoa truoc khi don phien.
    public async Task SweepAsync(string? disconnected = null)
    {
        await gate.WaitAsync();
        try { await SweepLockedAsync(disconnected); }
        finally { gate.Release(); }
    }

    // Lay tap tai khoan va ket noi hop le mot lan, roi loai phien het han, mat tab hoac bi khoa.
    // Sao chep danh sach truoc khi lap vi RemoveLockedAsync se xoa phan tu trong dictionary.
    private async Task SweepLockedAsync(string? disconnected = null)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var ids = active.Values.SelectMany(e => new[] { e.Session.UserAId, e.Session.UserBId }).Distinct().ToArray();
        if (ids.Length == 0) return;
        var enabled = (await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id) && !u.IsDisabled)
            .Select(u => u.Id).ToListAsync()).ToHashSet();
        var valid = presence.GetValidConnectionIds(ids).ToHashSet();
        foreach (var entry in active.Values.ToArray())
        {
            var s = entry.Session;
            if (entry.Deadline <= clock.GetUtcNow() || disconnected == s.ConnectionAId ||
                disconnected == s.ConnectionBId || !valid.Contains(s.ConnectionAId) ||
                !valid.Contains(s.ConnectionBId) || !enabled.Contains(s.UserAId) || !enabled.Contains(s.UserBId))
                await RemoveLockedAsync(entry);
        }
    }

    // Xoa khoi registry truoc khi bao hai tab, tranh su kien dong lap lai xu ly cung phien.
    private async Task RemoveLockedAsync(Entry entry)
    {
        var s = entry.Session;
        active.Remove(s.SessionId);
        await hub.Clients.Clients([s.ConnectionAId, s.ConnectionBId])
            .TextSessionClosed(new TextSessionClosedDto(s.SessionId, s.ConversationId));
    }

    // Them tien to TEXT_ de client phan biet loi nghiep vu cua phien text.
    private static HubException Error(string code) => new($"TEXT_{code}");
}
