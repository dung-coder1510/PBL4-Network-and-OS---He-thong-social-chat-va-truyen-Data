using PBL4.Contracts;

namespace PBL4.Realtime;

public interface IChatClient
{
    // Bao conversation moi/thay doi de client tai lai danh sach va thong tin lien quan.
    Task ConversationChanged(ConversationSubscriptionDto conversation);
    // Giao tin SQL chuan qua SignalR, gom duong cu, fallback va dong bo tab phu.
    Task MessageReceived(MessageDto message);
    // Phat receipt exact hoac cong don de client cap nhat da nhan/da doc.
    Task MessageStatusChanged(MessageStatusDto status);
    // Cap nhat online/offline va lastSeen cua tai khoan duoc theo doi.
    Task PresenceChanged(PresenceDto presence);
    // Bao trang thai dang nhap tam thoi cua peer, khong chua noi dung ban nhap.
    Task TypingChanged(TypingStateDto typing);
    // Phat metadata/trang thai phien file, khong gui byte file qua SignalR.
    Task FileChanged(FileTransferDto transfer);
    // Chuyen SDP/ICE cua file den tab da duoc chon.
    Task FileSignal(FileSignalDto signal);
    // Cap SessionId va cap endpoint text cho hai tab de bat dau thuong luong WebRTC.
    Task TextSessionStarted(TextPeerSessionDto session);
    // Chuyen offer/answer/ICE cua text trong dung phien.
    Task TextSignal(TextSignalDto signal);
    // Bao phien text da ket thuc de client don peer va tai bu tin chua giao.
    Task TextSessionClosed(TextSessionClosedDto session);
}
