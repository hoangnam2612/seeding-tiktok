using MyTikTokTool.Models;
namespace MyTikTokTool.Services;
// Electron owns persistence. Forward changes instead of opening a second account database.
public sealed class AccountService
{
    public Action<Account>? Updated { get; set; }
    public void UpdateAccount(Account account) => Updated?.Invoke(account);
}
