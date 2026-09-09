import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Snackbar } from '@moysklad/uikit'
import './styles/fonts.css'
import '@moysklad/uikit/colorVariables.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Snackbar>
        <App />
      </Snackbar>
    </BrowserRouter>
  </StrictMode>,
)
