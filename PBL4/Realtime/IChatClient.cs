using PBL4.Contracts;

namespace PBL4.Realtime;

public interface IChatClient
{
    Task MessageReceived(MessageDto message);
    Task MessageStatusChanged(MessageStatusDto status);
    Task PresenceChanged(PresenceDto presence);
    Task TypingChanged(TypingStateDto typing);
}
