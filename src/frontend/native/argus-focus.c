#include <windows.h>
#include <wchar.h>

typedef struct {
    HWND preferred;
    HWND fallback;
} FocusTarget;

static BOOL CALLBACK find_code_window(HWND window, LPARAM context) {
    FocusTarget *target = (FocusTarget *)context;
    if (!IsWindowVisible(window) || GetWindow(window, GW_OWNER) != NULL) return TRUE;

    wchar_t title[512];
    if (!GetWindowTextW(window, title, 512) || !wcsstr(title, L"Visual Studio Code")) return TRUE;

    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return TRUE;
    wchar_t process_path[MAX_PATH];
    DWORD length = MAX_PATH;
    BOOL matched = QueryFullProcessImageNameW(process, 0, process_path, &length)
        && length >= 8 && _wcsicmp(process_path + length - 8, L"Code.exe") == 0;
    CloseHandle(process);
    if (!matched) return TRUE;

    if (!target->fallback) target->fallback = window;
    if (wcsstr(title, L"Argus")) {
        target->preferred = window;
        return FALSE;
    }
    return TRUE;
}

static BOOL is_notification_popup(HWND window) {
    wchar_t class_name[64];
    if (!GetClassNameW(window, class_name, 64)
        || wcscmp(class_name, L"Windows.UI.Core.CoreWindow") != 0) return FALSE;
    RECT rect;
    if (!GetWindowRect(window, &rect)
        || rect.bottom - rect.top >= GetSystemMetrics(SM_CYSCREEN) / 2) return FALSE;
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return FALSE;
    wchar_t process_path[MAX_PATH];
    DWORD length = MAX_PATH;
    BOOL matched = QueryFullProcessImageNameW(process, 0, process_path, &length)
        && length >= 23 && _wcsicmp(process_path + length - 23, L"ShellExperienceHost.exe") == 0;
    CloseHandle(process);
    return matched;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command, int show) {
    (void)instance;
    (void)previous;
    (void)command;
    (void)show;
    FocusTarget target = {0};
    EnumWindows(find_code_window, (LPARAM)&target);
    HWND window = target.preferred ? target.preferred : target.fallback;
    if (!window) return 1;

    AllowSetForegroundWindow(ASFW_ANY);
    if (IsIconic(window)) ShowWindowAsync(window, SW_RESTORE);
    HWND foreground = GetForegroundWindow();
    BOOL popup = is_notification_popup(foreground);
    if (popup) {
        ShowWindowAsync(foreground, SW_HIDE);
    } else {
        keybd_event(VK_ESCAPE, 0, 0, 0);
        keybd_event(VK_ESCAPE, 0, KEYEVENTF_KEYUP, 0);
    }
    Sleep(150);
    SwitchToThisWindow(window, TRUE);
    BringWindowToTop(window);
    BOOL focused = SetForegroundWindow(window);
    if (popup) ShowWindowAsync(foreground, SW_SHOWNA);
    return focused ? 0 : 2;
}
