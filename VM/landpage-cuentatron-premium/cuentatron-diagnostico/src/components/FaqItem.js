// src/components/FaqItem.js
'use client'; // Necesario para usar useState

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export default function FaqItem({ question, answer }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-b border-gray-200">
      {/* Botón de la Pregunta */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex justify-between items-center py-5 text-left"
      >
        <span className="text-lg font-medium text-gris-grafito">
          {question}
        </span>
        <ChevronDown
          className={`flex-shrink-0 w-5 h-5 text-azul-confianza transition-transform duration-300 ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Contenedor de la Respuesta (animado) */}
      <div
        className={`grid transition-all duration-300 ease-in-out ${
          isOpen
            ? 'grid-rows-[1fr] opacity-100'
            : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <p className="pb-5 pr-10 text-gray-600">{answer}</p>
        </div>
      </div>
    </div>
  );
}