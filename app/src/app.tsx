import "virtual:uno.css";

import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import Nav from "~/components/Nav";
import { AuthProvider } from "~/components/AuthProvider";

export default function App() {
  return (
    <Router
      root={(props) => (
        <AuthProvider>
          <Nav />
          <Suspense>{props.children}</Suspense>
        </AuthProvider>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
