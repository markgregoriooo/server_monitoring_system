import { BRAND } from "../../branding";

/**
 * The Privacy Notice & Terms of Use text — ONE component, rendered both by the
 * public /privacy page and inside the acceptance gate. That is the point: the
 * document someone agrees to must be byte-for-byte the document anyone can read
 * without an account. Two copies would drift, and the drift would be invisible.
 *
 * Structured around what the Data Privacy Act of 2012 (RA 10173) expects a privacy
 * notice to state: what is collected, why, who sees it, how long it is kept, where
 * it lives, who it is shared with, and how a data subject exercises their rights.
 *
 * ⚠️ Everything here describes what the code actually does today. If you change
 * what the system collects, keeps, or sends, change this text AND bump
 * POLICY_VERSION in backend/services/policyService.js so everyone re-accepts.
 */

const CONTACT = BRAND.supportEmail || "ictusupport@cspc.edu.ph";

function H({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <h2 className="text-[14px] font-semibold mt-8 mb-3 first:mt-0" style={{ color: "var(--gf-text-primary)" }}>
      <span style={{ color: "var(--gf-text-dim)" }}>{n}.</span> {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13px] leading-[1.75] mb-3" style={{ color: "var(--gf-text-muted)" }}>
      {children}
    </p>
  );
}

function Row({ a, b }: { a: string; b: string }) {
  return (
    <tr style={{ borderTop: "1px solid var(--gf-divider)" }}>
      <td className="py-2.5 pr-4 align-top text-[12px] w-[38%]" style={{ color: "var(--gf-text-primary)" }}>
        {a}
      </td>
      <td className="py-2.5 align-top text-[12px] leading-relaxed" style={{ color: "var(--gf-text-muted)" }}>
        {b}
      </td>
    </tr>
  );
}

function Table({ head, children }: { head: [string, string]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto my-4">
      <table className="w-full border-collapse min-w-[420px]">
        <thead>
          <tr>
            <th
              className="text-left py-2 pr-4 text-[10px] tracking-[0.14em] uppercase font-medium"
              style={{ color: "var(--gf-text-dim)" }}
            >
              {head[0]}
            </th>
            <th
              className="text-left py-2 text-[10px] tracking-[0.14em] uppercase font-medium"
              style={{ color: "var(--gf-text-dim)" }}
            >
              {head[1]}
            </th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export default function PolicyDocument() {
  return (
    <div>
      <H n="1">Who this covers</H>
      <P>
        This notice applies to the {BRAND.fullName} monitoring system — the dashboard you are signing
        into. The system is operated by the CSPC Information and Communications Technology Unit
        (ICTU), which is the personal information controller for the data described below. It runs on
        equipment owned by the College and is reachable only from the campus network.
      </P>
      <P>
        Accounts are limited to CSPC staff with an <code>@cspc.edu.ph</code> or{" "}
        <code>@my.cspc.edu.ph</code> Google account, and every account must be approved by an
        administrator before it can be used.
      </P>

      <H n="2">What the system collects about you</H>
      <P>
        Signing in with Google gives this system your name, email address, Google account identifier
        and profile photo. Everything else is a record of what you did inside the dashboard.
      </P>
      <Table head={["Data", "Where it comes from"]}>
        <Row a="Name, email address, profile photo" b="Your CSPC Google account, re-read at each sign-in." />
        <Row
          a="Google account identifier"
          b="A permanent ID from Google, used to recognise your account even if your email address is renamed."
        />
        <Row a="Role and account status" b="Assigned by an administrator when your registration is approved." />
        <Row
          a="Sign-in activity"
          b="The time of each sign-in and sign-out, plus your IP address and browser. Refused sign-in attempts are recorded the same way."
        />
        <Row
          a="Actions you take"
          b="Acknowledging or resolving an alert, switching an air conditioner, generating or deleting a report, changing alert rules, and administering users — each recorded with your user ID and the time."
        />
        <Row a="Alert notifications" b="Which alerts were sent to you and which you have read." />
      </Table>
      <P>
        <strong style={{ color: "var(--gf-text-primary)" }}>What it does not collect.</strong> The
        measurements this system exists to gather — CPU, memory and disk usage, network throughput,
        UPS battery levels, room temperature, humidity and gas readings — describe equipment and the
        server room, not people. The system holds no password of yours (sign-in is handled entirely
        by Google), does not use tracking cookies, contains no advertising or analytics from third
        parties, and does not track your location.
      </P>

      <H n="3">Why it is collected</H>
      <P>
        Account and role data exist so the system knows who you are and which pages you may open.
        Sign-in and action records exist so changes to monitored infrastructure can be attributed —
        a shared account with no trail would make it impossible to tell who acknowledged an alert or
        powered a unit down. Your email address is also used to send you alert and report emails,
        which you can narrow or switch off in your notification preferences.
      </P>
      <P>
        The lawful basis is the legitimate interest of the College in securing and administering its
        own ICT infrastructure, and the necessity of this processing to your function as authorised
        ICTU personnel, under the Data Privacy Act of 2012 (RA 10173).
      </P>

      <H n="4">Who can see it</H>
      <P>
        Administrators of this system can see the account list, pending registrations and the full
        audit trail. IT staff can see the monitoring pages and the history of actions. Nobody outside
        the approved user list has access. Your data is not sold, rented, or disclosed for any
        commercial purpose.
      </P>
      <P>Two external services are involved, both limited to what is needed to operate:</P>
      <Table head={["Service", "What reaches it"]}>
        <Row
          a="Google (sign-in)"
          b="Sign-in is performed by Google. This system receives your identity from Google; it never sees your password. Your profile photo is loaded from Google's servers when the dashboard displays it."
        />
        <Row
          a="Email delivery"
          b="Alert and report emails are sent through the College's mail provider to your address. The message contains the alert or report and your name."
        />
      </Table>

      <H n="5">How long it is kept</H>
      <P>Records are deleted automatically once they pass the periods below.</P>
      <Table head={["Record", "Retention"]}>
        <Row a="Audit trail of sign-ins and actions" b="365 days, then deleted automatically each day." />
        <Row a="Alerts and your notification feed" b="30 days." />
        <Row a="Generated reports, including their files" b="90 days." />
        <Row a="On-site backup copies of measurements" b="30 days." />
        <Row
          a="Your account record"
          b="Kept while the account exists. On deactivation or removal it is deleted; audit entries already written remain until they age out, since they are the record of actions taken."
        />
      </Table>

      <H n="6">Where it is stored</H>
      <P>
        All data stays on College equipment on the CSPC campus network — nothing is hosted with a
        cloud provider. Account records, alerts, reports and the audit trail are held in a database
        on the monitoring server; measurements are held in a time-series database on the same
        machine; and a backup copy of measurements is written to a storage device attached to that
        server. Access to the machine itself is controlled by ICTU.
      </P>

      <H n="7">Your rights, and how to use them</H>
      <P>
        Under the Data Privacy Act of 2012 you may ask to see what the system holds about you, to
        have it corrected, to object to how it is processed, to have it erased where the law allows,
        and to be told if it is ever breached. To make any of these requests, write to{" "}
        <a href={`mailto:${CONTACT}`} style={{ color: "var(--gf-accent-text)" }}>
          {CONTACT}
        </a>
        .
      </P>
      <P>
        <strong style={{ color: "var(--gf-text-primary)" }}>One practical note on corrections.</strong>{" "}
        Your name, email address and profile photo are not editable in this dashboard — they are read
        from your CSPC Google account every time you sign in, so an edit here would be overwritten at
        your next login. Correct them in your Google account and the change will appear here
        automatically. Your display username is editable in your profile.
      </P>
      <P>
        If you believe your rights have been violated, you may also complain to the National Privacy
        Commission.
      </P>

      <H n="8">How it is protected</H>
      <P>
        Sign-in is delegated to Google and restricted to CSPC domains, so this system stores no
        passwords. Sessions expire after one hour, are ended after fifteen minutes of leaving the tab,
        and can be revoked immediately by an administrator. Each role can open only the pages assigned
        to it. Credentials the system stores for monitored network equipment are encrypted. The
        service is reachable only from the campus network.
      </P>

      <H n="9">Terms of use</H>
      <P>By using this system you agree to the following.</P>
      <P>
        Use it only for CSPC ICTU work you are authorised to perform. Do not share your account or
        leave a signed-in session unattended on a shared machine. Do not attempt to reach data or
        pages outside the role you were granted, and do not use it to interfere with monitored
        equipment outside your duties.
      </P>
      <P>
        Everything you do here is logged and attributed to your account. Acting through this dashboard
        can change real infrastructure — resolving an alert, retuning a threshold, or switching an air
        conditioner has an effect in the server room. Treat those actions accordingly.
      </P>
      <P>
        Information you see here about the College's infrastructure is internal. Do not republish it
        outside ICTU without permission. Misuse may result in your access being withdrawn and in
        action under College policy. Access may be suspended at any time by an administrator.
      </P>
      <P>
        This system is provided for the College's own operational use and is maintained on a
        best-effort basis; it is a monitoring aid, not a guarantee that every fault will be detected.
      </P>

      <H n="10">Changes to this notice</H>
      <P>
        If what the system collects, keeps or shares changes, this notice is updated and given a new
        version. You will be asked to read and accept it once more the next time you sign in. Your
        acceptance is recorded with the version, the date and time, and the address you accepted
        from.
      </P>

      <H n="11">Contact</H>
      <P>
        Questions about this notice, or any request concerning your data, go to the CSPC Information
        and Communications Technology Unit at{" "}
        <a href={`mailto:${CONTACT}`} style={{ color: "var(--gf-accent-text)" }}>
          {CONTACT}
        </a>
        .
      </P>
    </div>
  );
}
