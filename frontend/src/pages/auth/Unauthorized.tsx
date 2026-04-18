interface UnauthorizedProps {
  onBack? : () => void;
}

export default function Unauthorized({ onBack }: UnauthorizedProps) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 p-8 text-center">
      <div className="text-6xl mb-4">🔒</div>
      <h2 className="text-xl font-bold text-white mb-2">Access Denied</h2>
      <p className="text-slate-400 text-sm mb-6 max-w-xs">
        You don't have permission to view this page. Contact your administrator to request access.
      </p>
      <button onClick={onBack}
        className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-700 to-blue-500
          text-white font-semibold text-sm border-none cursor-pointer hover:opacity-90 transition">
        ← Go Back
      </button>
    </div>
  );
}
