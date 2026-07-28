Option Explicit

Dim arguments
Set arguments = WScript.Arguments

If arguments.Count < 1 Then
  WScript.Echo "Usage: dashboard-hidden-launcher.vbs [--wait] <command> [args...]"
  WScript.Quit 64
End If

Dim waitForExit, firstCommandIndex
waitForExit = False
firstCommandIndex = 0

If LCase(arguments.Item(0)) = "--wait" Then
  waitForExit = True
  firstCommandIndex = 1
End If

If arguments.Count <= firstCommandIndex Then
  WScript.Echo "Usage: dashboard-hidden-launcher.vbs [--wait] <command> [args...]"
  WScript.Quit 64
End If

Dim command, index
command = QuoteArgument(arguments.Item(firstCommandIndex))
For index = firstCommandIndex + 1 To arguments.Count - 1
  command = command & " " & QuoteArgument(arguments.Item(index))
Next

Dim shell, exitCode
Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run(command, 0, waitForExit)
WScript.Quit exitCode

Function QuoteArgument(value)
  QuoteArgument = """" & Replace(CStr(value), """", """""") & """"
End Function
