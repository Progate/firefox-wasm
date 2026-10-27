// SPDX-License-Identifier: MPL-2.0
#include "devtools-pipe.h"

#include "nsIObserver.h"
#include "nsIObserverService.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsThreadUtils.h"
#include <cerrno>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <unistd.h>

namespace {

constexpr int kReadFd = 3;
constexpr int kWriteFd = 4;
constexpr char kStart[] = "firedog-devtools-pipe-start";
constexpr char kMessage[] = "firedog-devtools-pipe-message";
constexpr char kSend[] = "firedog-devtools-pipe-send";
constexpr char kClosed[] = "firedog-devtools-pipe-closed";

void notify(const char* topic, const std::string& text) {
  nsCOMPtr<nsIObserverService> observers = do_GetService("@mozilla.org/observer-service;1");
  if (observers) {
    observers->NotifyObservers(nullptr, topic,
                              NS_ConvertUTF8toUTF16(nsDependentCSubstring(text.data(), text.size())).get());
  }
}

void postToMain(const char* topic, std::string text) {
  NS_DispatchToMainThread(NS_NewRunnableFunction(
      "firedog::devtools-pipe", [topic, text = std::move(text)] { notify(topic, text); }));
}

// Splits descriptor 3 at the NUL bytes and hands each message to the main
// thread, in order. Ends at end of file or an error (the client is gone).
void readLoop() {
  std::string pending;
  char buffer[64 * 1024];
  for (;;) {
    const ssize_t got = read(kReadFd, buffer, sizeof buffer);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) break;
    pending.append(buffer, static_cast<size_t>(got));
    size_t start = 0;
    for (size_t end; (end = pending.find('\0', start)) != std::string::npos; start = end + 1) {
      postToMain(kMessage, pending.substr(start, end - start));
    }
    pending.erase(0, start);
  }
  postToMain(kClosed, std::string());
}

// The writer's queue. The main thread only appends, so a slow reader on the
// other end (a large screenshot) never holds up Gecko.
std::mutex g_lock;
std::condition_variable g_ready;
std::deque<std::string> g_outgoing;
// Set once descriptor 4 stops taking writes. Requests may still arrive on 3,
// and their responses would otherwise pile up in g_outgoing for good.
bool g_writerGone = false;

void writeLoop() {
  for (;;) {
    std::string message;
    {
      std::unique_lock<std::mutex> lock(g_lock);
      g_ready.wait(lock, [] { return !g_outgoing.empty(); });
      message = std::move(g_outgoing.front());
      g_outgoing.pop_front();
    }
    size_t written = 0;
    while (written < message.size()) {
      const ssize_t done = write(kWriteFd, message.data() + written, message.size() - written);
      if (done < 0 && errno == EINTR) continue;
      // The client closed its end (EPIPE): nothing more can reach it. The
      // write does not end FireDog with SIGPIPE: NSPR ignores that signal
      // for the whole process (_PR_UnixInit), as in Firefox on Linux.
      if (done <= 0) {
        std::lock_guard<std::mutex> lock(g_lock);
        g_writerGone = true;
        g_outgoing.clear();
        return;
      }
      written += static_cast<size_t>(done);
    }
  }
}

class PipeObserver final : public nsIObserver {
 public:
  NS_DECL_ISUPPORTS
  NS_IMETHOD Observe(nsISupports*, const char* topic, const char16_t* data) override {
    if (strcmp(topic, kStart) == 0) {
      if (!started_) {
        started_ = true;
        std::thread(readLoop).detach();
        std::thread(writeLoop).detach();
      }
      return NS_OK;
    }
    if (strcmp(topic, kSend) == 0 && data) {
      NS_ConvertUTF16toUTF8 text(data);
      std::string message(text.BeginReading(), text.Length());
      message.push_back('\0');
      {
        std::lock_guard<std::mutex> lock(g_lock);
        if (g_writerGone) return NS_OK;
        g_outgoing.push_back(std::move(message));
      }
      g_ready.notify_one();
    }
    return NS_OK;
  }

 private:
  ~PipeObserver() = default;
  bool started_ = false;
};
NS_IMPL_ISUPPORTS(PipeObserver, nsIObserver)

}  // namespace

void registerDevToolsPipe() {
  nsCOMPtr<nsIObserverService> observers = do_GetService("@mozilla.org/observer-service;1");
  if (!observers) return;
  nsCOMPtr<nsIObserver> observer = new PipeObserver();
  observers->AddObserver(observer, kStart, false);
  observers->AddObserver(observer, kSend, false);
}
