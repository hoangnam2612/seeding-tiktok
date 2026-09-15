using System;
using System.Collections.Generic;

namespace MyTikTokTool.Models;

public class Category
{
    public int Id { get; set; }
    public string Name { get; set; } = "Mặc định";
    public string? Type { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    public virtual ICollection<Account> Accounts { get; set; } = new List<Account>();
}
