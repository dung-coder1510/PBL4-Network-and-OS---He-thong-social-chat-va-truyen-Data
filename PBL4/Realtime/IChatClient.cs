using PBL4.Contracts;

namespace PBL4.Realtime;

public interface IChatClient
{
    Task ConversationChanged(ConversationSubscriptionDto conversation);
    Task MessageReceived(MessageDto message);
    Task MessageStatusChanged(MessageStatusDto status);
    Task PresenceChanged(PresenceDto presence);
    Task TypingChanged(TypingStateDto typing);
    Task FileChanged(FileTransferDto transfer);
    Task FileSignal(FileSignalDto signal);
}
