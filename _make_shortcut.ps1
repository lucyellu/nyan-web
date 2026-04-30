$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut('C:\Users\lucyl\Desktop\Nyan Web.lnk')
$lnk.TargetPath = 'C:\Users\lucyl\Desktop\hold\projects\stocks_app\nyan-web\play.bat'
$lnk.WorkingDirectory = 'C:\Users\lucyl\Desktop\hold\projects\stocks_app\nyan-web'
$lnk.IconLocation = 'C:\Users\lucyl\Desktop\hold\projects\stocks_app\nyan-web\favicon.ico,0'
$lnk.Description = 'Nyan Web - Virtual Paper Trading Game'
$lnk.WindowStyle = 1
$lnk.Save()
Write-Output 'Shortcut created at C:\Users\lucyl\Desktop\Nyan Web.lnk'
