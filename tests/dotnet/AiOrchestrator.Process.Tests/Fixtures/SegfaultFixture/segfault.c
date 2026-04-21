/*
 * segfault.c — minimal C program that raises SIGSEGV to trigger a crash dump.
 * Built at test time by the AiOrchestrator.Process.Tests project to exercise
 * PROC-6 (crash dump capture on abnormal exit).
 *
 * Build (Linux):   gcc -O0 -o segfault segfault.c
 * Build (Windows): cl.exe /nologo /Od /Fe:segfault.exe segfault.c
 */

#include <signal.h>
#include <stdlib.h>

int main(void)
{
    /* Raise SIGSEGV directly — portable across Linux and macOS */
    raise(SIGSEGV);
    return 0; /* unreachable */
}
