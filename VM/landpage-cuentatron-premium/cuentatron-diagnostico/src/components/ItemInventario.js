// src/components/ItemInventario.js
'use client';
import { Minus, Plus } from 'lucide-react';

// Componente para los contadores [+] [-]
export default function ItemInventario({ label, value, onIncrement, onDecrement }) {
  return (
    <div className="flex flex-col sm:flex-row justify-between items-center py-3 border-b border-gray-300">
      <label className="text-lg text-gray-800 mb-2 sm:mb-0">{label}</label>
      <div className="flex items-center space-x-2">
        {/* Botón de Menos (cumple 44px) */}
        <button
          type="button"
          onClick={onDecrement}
          disabled={value <= 0}
          className="flex items-center justify-center h-11 w-11 rounded-full bg-gray-200 text-gray-700 disabled:opacity-50 transition-colors"
          aria-label={`Reducir ${label}`}
        >
          <Minus className="w-5 h-5" />
        </button>

        {/* Valor */}
        <span className="text-xl font-bold text-gris-grafito w-10 text-center">
          {value}
        </span>

        {/* Botón de Más (cumple 44px) */}
        <button
          type="button"
          onClick={onIncrement}
          className="flex items-center justify-center h-11 w-11 rounded-full bg-azul-confianza text-white transition-colors"
          aria-label={`Aumentar ${label}`}
        >
          <Plus className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}