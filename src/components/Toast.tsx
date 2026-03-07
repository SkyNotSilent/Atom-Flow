import React from "react";
import { useAppContext } from "../context/AppContext";

export const Toast: React.FC = () => {
  const { toastMsg } = useAppContext();

  if (!toastMsg) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[999] bg-[#1C1916] text-white text-[13.5px] rounded-full px-[22px] py-[10px] animate-in slide-in-from-bottom-10 duration-300">
      {toastMsg}
    </div>
  );
};
