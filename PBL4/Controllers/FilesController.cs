using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PBL4.Contracts;
using PBL4.Services;

namespace PBL4.Controllers;

[ApiController, Authorize]
[Route("api/v1/files")]
public sealed class FilesController(FileTransferService files, IConfiguration configuration) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<FilePageDto>> List([FromQuery] long? beforeId)
    {
        if (beforeId <= 0) return BadRequest();
        return Ok(await files.ListAsync(int.Parse(User.FindFirstValue("sub")!), beforeId));
    }

    [HttpGet("configuration")]
    public IActionResult Configuration() => Ok(new
    {
        maximumFileBytes = FileTransferService.MaximumFileBytes,
        iceServers = configuration.GetSection("WebRtc:IceServers").Get<IceServer[]>() ?? []
    });

    public sealed record IceServer(string[] Urls, string? Username, string? Credential);
}
