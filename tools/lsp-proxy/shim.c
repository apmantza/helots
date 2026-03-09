/**
 * typescript-language-server.exe shim
 *
 * Launches: node <proxy.js> [args...]
 * Uses CreateProcess with STARTF_USESTDHANDLES so that the inherited stdin/stdout
 * pipe handles from Claude Code are explicitly forwarded to node.
 *
 * Compiled with:
 *   gcc -o typescript-language-server.exe shim.c -mconsole -lkernel32
 *
 * Place output at: %APPDATA%\npm\typescript-language-server.exe
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PROXY_JS "C:\\Users\\R3LiC\\AppData\\Roaming\\npm\\node_modules\\helots-lsp-proxy\\typescript-language-server.js"

int main(int argc, char *argv[]) {
    /* Build command line: node "proxy.js" [original args except argv[0]] */
    char cmdline[8192];
    int pos = 0;

    /* Start with: node "PROXY_JS" */
    pos += snprintf(cmdline + pos, sizeof(cmdline) - pos,
                    "node \"%s\"", PROXY_JS);

    /* Append original args (skip argv[0] which is the shim itself) */
    for (int i = 1; i < argc; i++) {
        pos += snprintf(cmdline + pos, sizeof(cmdline) - pos, " %s", argv[i]);
    }

    STARTUPINFOA si = {0};
    PROCESS_INFORMATION pi = {0};

    si.cb         = sizeof(si);
    si.dwFlags    = STARTF_USESTDHANDLES;
    si.hStdInput  = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError  = GetStdHandle(STD_ERROR_HANDLE);

    BOOL ok = CreateProcessA(
        NULL,       /* lpApplicationName — use cmdline */
        cmdline,    /* lpCommandLine */
        NULL,       /* lpProcessAttributes */
        NULL,       /* lpThreadAttributes */
        TRUE,       /* bInheritHandles — critical: pass pipe handles to child */
        0,          /* dwCreationFlags */
        NULL,       /* lpEnvironment — inherit parent env */
        NULL,       /* lpCurrentDirectory — inherit cwd */
        &si,
        &pi
    );

    if (!ok) {
        DWORD err = GetLastError();
        fprintf(stderr, "[lsp-shim] CreateProcess failed: error %lu\n", err);
        fprintf(stderr, "[lsp-shim] cmdline was: %s\n", cmdline);
        return 1;
    }

    /* Wait for node to finish, then exit with its code */
    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD exitCode = 0;
    GetExitCodeProcess(pi.hProcess, &exitCode);

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    return (int)exitCode;
}
