using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace MyTikTokTool.Services;

/// <summary>
/// Cầu nối Proxy cục bộ siêu nhẹ (Local Proxy Bridge) - Tự động đính kèm User:Pass cho Upstream Proxy
/// </summary>
public class LocalProxyBridge
{
    private static readonly ConcurrentDictionary<int, LocalProxyBridge> _activeBridges = new();

    private readonly TcpListener _listener;
    private readonly string _remoteHost;
    private readonly int _remotePort;
    private readonly string _authHeader;
    private readonly CancellationTokenSource _cts = new();

    public int LocalPort { get; }

    private LocalProxyBridge(string remoteHost, int remotePort, string username, string password)
    {
        _remoteHost = remoteHost;
        _remotePort = remotePort;

        string creds = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{username}:{password}"));
        _authHeader = $"Proxy-Authorization: Basic {creds}\r\n";

        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        LocalPort = ((IPEndPoint)_listener.LocalEndpoint).Port;

        Task.Run(ListenLoop);
    }

    public static int GetOrCreateBridge(int accountId, string proxyString)
    {
        if (_activeBridges.TryGetValue(accountId, out var existing))
        {
            return existing.LocalPort;
        }

        string[] parts = proxyString.Trim().Split(':');
        if (parts.Length >= 4)
        {
            string host = parts[0].Trim();
            int port = int.Parse(parts[1].Trim());
            string user = parts[2].Trim();
            string pass = parts[3].Trim();

            var bridge = new LocalProxyBridge(host, port, user, pass);
            _activeBridges[accountId] = bridge;
            return bridge.LocalPort;
        }

        return 0;
    }

    public static void StopBridge(int accountId)
    {
        if (_activeBridges.TryRemove(accountId, out var bridge))
        {
            bridge.Stop();
        }
    }

    public void Stop()
    {
        try
        {
            _cts.Cancel();
            _listener.Stop();
        }
        catch { }
    }

    private async Task ListenLoop()
    {
        while (!_cts.Token.IsCancellationRequested)
        {
            try
            {
                var clientSocket = await _listener.AcceptTcpClientAsync(_cts.Token);
                _ = Task.Run(() => HandleClient(clientSocket));
            }
            catch
            {
                break;
            }
        }
    }

    private async Task HandleClient(TcpClient client)
    {
        using (client)
        {
            try
            {
                client.NoDelay = true;
                using var remote = new TcpClient();
                remote.NoDelay = true;
                await remote.ConnectAsync(_remoteHost, _remotePort, _cts.Token);

                var clientStream = client.GetStream();
                var remoteStream = remote.GetStream();

                byte[] buffer = new byte[32768];
                int bytesRead = await clientStream.ReadAsync(buffer, 0, buffer.Length, _cts.Token);
                if (bytesRead <= 0) return;

                string initialRequest = Encoding.ASCII.GetString(buffer, 0, bytesRead);

                // Inject Proxy-Authorization header
                string modifiedRequest;
                int headerEnd = initialRequest.IndexOf("\r\n");
                if (headerEnd > 0)
                {
                    string firstLine = initialRequest.Substring(0, headerEnd + 2);
                    string rest = initialRequest.Substring(headerEnd + 2);
                    modifiedRequest = firstLine + _authHeader + rest;
                }
                else
                {
                    modifiedRequest = initialRequest;
                }

                byte[] modifiedBytes = Encoding.ASCII.GetBytes(modifiedRequest);
                await remoteStream.WriteAsync(modifiedBytes, 0, modifiedBytes.Length, _cts.Token);

                // Pipe streams without premature disconnection
                async Task CopyStreamAsync(NetworkStream src, NetworkStream dst, TcpClient dstClient)
                {
                    try
                    {
                        await src.CopyToAsync(dst, _cts.Token);
                    }
                    catch { }
                    finally
                    {
                        try { dstClient.Client.Shutdown(SocketShutdown.Send); } catch { }
                    }
                }

                var task1 = CopyStreamAsync(clientStream, remoteStream, remote);
                var task2 = CopyStreamAsync(remoteStream, clientStream, client);

                await Task.WhenAll(task1, task2);
            }
            catch { }
        }
    }
}
