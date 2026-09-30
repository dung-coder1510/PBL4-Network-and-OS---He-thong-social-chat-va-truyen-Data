using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Models;
using PBL4.Realtime;

namespace PBL4.Controllers;

[ApiController, Authorize]
[Route("api/v1/contacts")]
public sealed class ContactsController(AppDbContext db, PresenceTracker presence) : ControllerBase
{
    private int CurrentUserId => int.Parse(User.FindFirstValue("sub")!, CultureInfo.InvariantCulture);

    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<ContactDto>>> List(CancellationToken ct)
    {
        var userId = CurrentUserId;
        var contacts = await db.Contacts.AsNoTracking().Where(c => c.UserId == userId)
            .OrderBy(c => c.Alias ?? c.ContactUser.DisplayName).ThenBy(c => c.ContactUser.Username)
            .Select(c => new ContactDto(new ConversationUserDto(
                c.ContactUser.Id, c.ContactUser.Username, c.ContactUser.DisplayName,
                c.ContactUser.AvatarPath, c.ContactUser.IsDisabled, false,
                c.ContactUser.LastSeenAt), c.Alias,
                DateTime.SpecifyKind(c.CreatedAt, DateTimeKind.Utc)))
            .ToListAsync(ct);
        return Ok(contacts.Select(WithPresence).ToList());
    }

    [HttpPost]
    [RequestSizeLimit(2048)]
    public async Task<ActionResult<ContactDto>> Create(CreateContactDto request, CancellationToken ct)
    {
        var userId = CurrentUserId;
        if (request.ContactUserId == userId)
            return Problem(statusCode: 400, title: "Không thể thêm chính mình vào danh bạ.");
        if (!await db.Users.AnyAsync(u => u.Id == request.ContactUserId && !u.IsDisabled, ct))
            return Problem(statusCode: 404, title: "Người dùng không tồn tại hoặc không còn khả dụng.");
        var alias = NormalizeAlias(request.Alias);
        var existing = await Find(userId, request.ContactUserId, ct);
        if (existing is not null) return Ok(WithPresence(existing));

        db.Contacts.Add(new Contact
        {
            UserId = userId,
            ContactUserId = request.ContactUserId,
            Alias = alias,
            CreatedAt = DateTime.UtcNow
        });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 2601 or 2627 })
        {
            var winner = await Find(userId, request.ContactUserId, ct);
            if (winner is null) throw;
            return Ok(WithPresence(winner));
        }
        var result = await Find(userId, request.ContactUserId, ct) ?? throw new InvalidOperationException();
        return CreatedAtAction(nameof(List), WithPresence(result));
    }

    [HttpPut("{contactUserId:int}")]
    [RequestSizeLimit(1024)]
    public async Task<ActionResult<ContactDto>> Update(int contactUserId,
        UpdateContactDto request, CancellationToken ct)
    {
        var userId = CurrentUserId;
        var contact = await db.Contacts.SingleOrDefaultAsync(c =>
            c.UserId == userId && c.ContactUserId == contactUserId, ct);
        if (contact is null) return MissingContact();
        contact.Alias = NormalizeAlias(request.Alias);
        await db.SaveChangesAsync(ct);
        var result = await Find(userId, contactUserId, ct) ?? throw new InvalidOperationException();
        return Ok(WithPresence(result));
    }

    [HttpDelete("{contactUserId:int}")]
    public async Task<IActionResult> Delete(int contactUserId, CancellationToken ct)
    {
        var deleted = await db.Contacts.Where(c =>
            c.UserId == CurrentUserId && c.ContactUserId == contactUserId)
            .ExecuteDeleteAsync(ct);
        return deleted == 0 ? MissingContact() : NoContent();
    }

    private async Task<ContactDto?> Find(int userId, int contactUserId, CancellationToken ct) =>
        await db.Contacts.AsNoTracking().Where(c =>
            c.UserId == userId && c.ContactUserId == contactUserId)
            .Select(c => new ContactDto(new ConversationUserDto(
                c.ContactUser.Id, c.ContactUser.Username, c.ContactUser.DisplayName,
                c.ContactUser.AvatarPath, c.ContactUser.IsDisabled, false,
                c.ContactUser.LastSeenAt), c.Alias,
                DateTime.SpecifyKind(c.CreatedAt, DateTimeKind.Utc)))
            .SingleOrDefaultAsync(ct);

    private ContactDto WithPresence(ContactDto contact) => contact with
    {
        User = contact.User with
        {
            IsOnline = presence.IsOnline(contact.User.Id),
            LastSeenAt = contact.User.LastSeenAt.HasValue
                ? DateTime.SpecifyKind(contact.User.LastSeenAt.Value, DateTimeKind.Utc) : null
        }
    };

    private static string? NormalizeAlias(string? alias)
    {
        var normalized = alias?.Trim();
        return string.IsNullOrEmpty(normalized) ? null : normalized;
    }

    private ObjectResult MissingContact() =>
        Problem(statusCode: 404, title: "Không tìm thấy liên hệ.");
}
